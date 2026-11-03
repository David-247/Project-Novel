import { emptyDoc, getDocumentProvider, type DocJSON, type DocumentProvider } from '@/shared/document'
import { useStore, type RecentProject } from '@/shared/store'
import { openProjectIndex, recordRevision, type ProjectIndex } from './db'
import { askUnsavedChanges, showError } from './dialogs'
import {
  baseName,
  INDEX_FILE,
  joinPath,
  MANUSCRIPT_FILE,
  newProjectMeta,
  parseManuscript,
  parseProjectMeta,
  PROJECT_FILE,
  ProjectError,
  serializeManuscript,
  serializeProjectMeta,
  type ProjectMeta,
} from './format'
import {
  clearProjectRoot,
  openRecentRoot,
  pathExists,
  pickProjectFolder,
  readRecentRaw,
  readTextFile,
  rememberRecentRaw,
  restoreProjectRoot,
  setRecentMenu,
  writeFileAtomic,
} from './ipc'
import { flagMissing, parseRecentFile } from './recent'
import type { RevisionKind } from './schema'

export interface OpenedProject {
  path: string
  meta: ProjectMeta
}

/** Window in which a repeated manual save of an unchanged doc is ignored (menu + webview Mod-S both fire). */
const SAVE_COALESCE_MS = 500

let currentMeta: ProjectMeta | null = null
let currentIndex: ProjectIndex | null = null
let inFlightSave: Promise<boolean> | null = null
let lastSaveDoneAt = 0
const openedListeners = new Set<(p: OpenedProject) => void>()

/** The registered editor; storage cannot work without one. */
function provider(): DocumentProvider {
  const p = getDocumentProvider()
  if (!p) throw new ProjectError('no-editor', 'The editor is not ready yet. Please try again in a moment.')
  return p
}

const actions = () => useStore.getState().projectActions

/** Absolute path of the open project folder, or null. */
export function getCurrentProjectPath(): string | null {
  return useStore.getState().project.path
}

/** Metadata (project.json) of the open project, or null. */
export function getCurrentProjectMeta(): ProjectMeta | null {
  return currentMeta
}

/** Subscribe to "a project was opened or created". Returns unsubscribe. */
export function onProjectOpened(cb: (p: OpenedProject) => void): () => void {
  openedListeners.add(cb)
  return () => openedListeners.delete(cb)
}

async function openIndexSafely(folder: string): Promise<ProjectIndex | null> {
  try {
    return await openProjectIndex(joinPath(folder, INDEX_FILE))
  } catch (e) {
    // The index is secondary data: the project works without it.
    console.warn('Project index unavailable:', e)
    return null
  }
}

async function closeIndex(): Promise<void> {
  const idx = currentIndex
  currentIndex = null
  if (idx) await idx.close().catch((e) => console.warn('Closing project index failed:', e))
}

/** Load `doc` into the editor; a doc the editor schema rejects is reported as a damaged manuscript. */
function loadDocument(p: DocumentProvider, doc: DocJSON): void {
  try {
    p.setDocJSON(doc)
  } catch (cause) {
    throw new ProjectError(
      'corrupt-file',
      `${MANUSCRIPT_FILE} is damaged: it contains content Novel cannot display.`,
      { cause },
    )
  }
}

/** Switch module + store state to the project in `folder` (files already read/written). */
async function activate(folder: string, meta: ProjectMeta, index: ProjectIndex | null) {
  await closeIndex()
  currentMeta = meta
  currentIndex = index
  lastSaveDoneAt = 0
  actions().projectOpened({ path: folder, title: meta.title })
  openedListeners.forEach((cb) => cb({ path: folder, meta }))
  await rememberRecent(meta.title)
}

/**
 * Create a project in `folder`, which must already be the granted project root
 * (via the Rust folder dialog). With `doc`, the editor is loaded with it; with
 * null, the editor's current content becomes the manuscript (Save As).
 * Throws ProjectError.
 */
export async function createProjectAt(folder: string, doc: DocJSON | null = emptyDoc()): Promise<void> {
  const p = provider()
  if (await pathExists(joinPath(folder, PROJECT_FILE))) {
    throw new ProjectError(
      'already-exists',
      `This folder already contains a Novel project. Use Open Project to open it, or choose an empty folder.`,
    )
  }
  const version = p.getDocVersion()
  const content = doc ?? p.getDocJSON()
  const meta = newProjectMeta(baseName(folder))
  await writeFileAtomic(joinPath(folder, MANUSCRIPT_FILE), serializeManuscript(content), MANUSCRIPT_FILE)
  await writeFileAtomic(joinPath(folder, PROJECT_FILE), serializeProjectMeta(meta), PROJECT_FILE)
  if (doc) loadDocument(p, doc)
  else p.markClean(version)
  const index = await openIndexSafely(folder)
  await activate(folder, meta, index)
}

/** Open the project in `folder` (already the granted root). Throws ProjectError for missing/corrupt files. */
export async function openProjectAt(folder: string): Promise<void> {
  const p = provider()
  let metaText: string
  try {
    metaText = await readTextFile(joinPath(folder, PROJECT_FILE), PROJECT_FILE)
  } catch (e) {
    if (e instanceof ProjectError && e.code === 'missing-file') {
      throw new ProjectError('not-a-project', `This folder is not a Novel project (it has no ${PROJECT_FILE}).`)
    }
    throw e
  }
  const meta = parseProjectMeta(metaText)
  let docText: string
  try {
    docText = await readTextFile(joinPath(folder, MANUSCRIPT_FILE), MANUSCRIPT_FILE)
  } catch (e) {
    if (e instanceof ProjectError && e.code === 'missing-file') {
      throw new ProjectError('missing-file', `${MANUSCRIPT_FILE} is missing from this project, so it cannot be opened.`)
    }
    throw e
  }
  loadDocument(p, parseManuscript(docText))
  const index = await openIndexSafely(folder)
  await activate(folder, meta, index)
}

/**
 * Run `fn` for a root that was just granted; if it fails, return Rust's
 * confinement to the previous project so it can still be saved.
 */
async function inGrantedRoot(fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
  } catch (e) {
    await restoreProjectRoot()
    throw e
  }
}

export interface SaveOptions {
  /** Recorded in the revisions index. Default 'manual'. */
  kind?: RevisionKind
  /** If true, failures update the store but show no dialog (for autosave). Default false. */
  silent?: boolean
}

/**
 * Save the open project: manuscript.json then project.json (each written
 * atomically), then record a revision in index.sqlite. If no project is open,
 * a manual save asks for a folder and creates one from the current document.
 * Concurrent calls share one in-flight save. Resolves true on success.
 */
export function saveProject(opts: SaveOptions = {}): Promise<boolean> {
  if (inFlightSave) return inFlightSave
  const kind = opts.kind ?? 'manual'
  const folder = getCurrentProjectPath()
  if (!folder || !currentMeta) {
    if (kind !== 'manual') return Promise.resolve(false)
    return saveAsNewProject()
  }
  const p = getDocumentProvider()
  if (!p) return Promise.resolve(false)
  if (kind === 'manual' && !p.isDirty() && Date.now() - lastSaveDoneAt < SAVE_COALESCE_MS) {
    return Promise.resolve(true)
  }
  inFlightSave = writeProject(folder, currentMeta, p, kind, opts.silent ?? false).finally(() => {
    inFlightSave = null
  })
  return inFlightSave
}

async function writeProject(
  folder: string,
  meta: ProjectMeta,
  p: DocumentProvider,
  kind: RevisionKind,
  silent: boolean,
): Promise<boolean> {
  actions().saveStarted()
  try {
    // Version read before the doc: edits made during the async write keep the doc dirty.
    const version = p.getDocVersion()
    const text = serializeManuscript(p.getDocJSON())
    await writeFileAtomic(joinPath(folder, MANUSCRIPT_FILE), text, MANUSCRIPT_FILE)
    const updated: ProjectMeta = { ...meta, updatedAt: new Date().toISOString() }
    await writeFileAtomic(joinPath(folder, PROJECT_FILE), serializeProjectMeta(updated), PROJECT_FILE)
    if (currentMeta === meta) currentMeta = updated
    p.markClean(version)
    if (currentIndex) {
      const byteSize = new TextEncoder().encode(text).length
      await recordRevision(currentIndex, { kind, byteSize, path: MANUSCRIPT_FILE }).catch((e) =>
        console.warn('Recording revision failed:', e),
      )
    }
    lastSaveDoneAt = Date.now()
    actions().saveSucceeded(lastSaveDoneAt)
    return true
  } catch (e) {
    const msg = e instanceof ProjectError ? e.message : 'The project could not be saved.'
    actions().saveFailed(msg)
    if (!silent) await showError('Could not save', e)
    return false
  }
}

async function saveAsNewProject(): Promise<boolean> {
  try {
    provider()
    const folder = await pickProjectFolder('Choose a folder for your project')
    if (!folder) return false
    await inGrantedRoot(() => createProjectAt(folder, null))
    return true
  } catch (e) {
    await showError('Could not save', e)
    return false
  }
}

/**
 * If the document has unsaved changes, ask Save / Don't Save / Cancel.
 * Resolves true when it is OK to proceed (saved or discarded).
 */
export async function confirmUnsavedChanges(action = 'continuing'): Promise<boolean> {
  const p = getDocumentProvider()
  if (!p || !p.isDirty()) return true
  try {
    const choice = await askUnsavedChanges(useStore.getState().project.title, action)
    if (choice === 'save') return await saveProject()
    return choice === 'discard'
  } catch (e) {
    console.error('Unsaved-changes prompt failed:', e)
    return false
  }
}

/** Menu action: File > New Project. */
export async function newProject(): Promise<boolean> {
  if (!(await confirmUnsavedChanges('creating a new project'))) return false
  try {
    provider()
    const folder = await pickProjectFolder('Choose a folder for the new project')
    if (!folder) return false
    await inGrantedRoot(() => createProjectAt(folder, emptyDoc()))
    return true
  } catch (e) {
    await showError('Could not create project', e)
    return false
  }
}

/**
 * Menu action: File > Open Project... (native dialog), or open `folder`
 * from Open Recent (Rust accepts only folders in its recent list).
 */
export async function openProject(folder?: string): Promise<boolean> {
  if (!(await confirmUnsavedChanges('opening another project'))) return false
  let target = folder ?? null
  try {
    provider()
    if (target) await openRecentRoot(target)
    else target = await pickProjectFolder('Open a Novel project folder')
    if (!target) return false
    const granted = target
    await inGrantedRoot(() => openProjectAt(granted))
    return true
  } catch (e) {
    if (target && e instanceof ProjectError && (e.code === 'missing-folder' || e.code === 'not-a-project')) {
      setRecent(flagMissing(useStore.getState().project.recent, target, true))
    }
    await showError('Could not open project', e)
    return false
  }
}

/** Close the open project (no prompt; call confirmUnsavedChanges first). */
export async function closeProject(): Promise<void> {
  await closeIndex()
  await clearProjectRoot()
  currentMeta = null
  lastSaveDoneAt = 0
  actions().projectClosed()
}

// ---- Recent projects (file written only by Rust) ---------------------------

async function syncRecentMenu(list: RecentProject[]): Promise<void> {
  try {
    await setRecentMenu(list.map((r) => ({ path: r.path, label: `${r.name} (${r.path})`, missing: !!r.missing })))
  } catch (e) {
    console.warn('Updating the Open Recent menu failed:', e)
  }
}

function setRecent(list: RecentProject[]): void {
  actions().setRecent(list)
  void syncRecentMenu(list)
}

async function rememberRecent(name: string): Promise<void> {
  try {
    setRecent(parseRecentFile(await rememberRecentRaw(name, new Date().toISOString())))
  } catch (e) {
    console.warn('Saving the recent-projects list failed:', e)
  }
}

/** Load recent-projects.json from the app config dir, flag missing folders, update store + menu. */
export async function loadRecentProjects(): Promise<RecentProject[]> {
  let list: RecentProject[] = []
  try {
    list = parseRecentFile(await readRecentRaw())
  } catch (e) {
    console.warn('Reading the recent-projects list failed:', e)
  }
  const checked = await Promise.all(
    list.map(async (r) => ((await pathExists(joinPath(r.path, PROJECT_FILE))) ? r : { ...r, missing: true })),
  )
  actions().setRecent(checked)
  await syncRecentMenu(checked)
  return checked
}

/** Test-only: reset module state. */
export async function __resetStorageForTests(): Promise<void> {
  await closeIndex()
  currentMeta = null
  inFlightSave = null
  lastSaveDoneAt = 0
  openedListeners.clear()
}
