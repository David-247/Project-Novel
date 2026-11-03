import {
  createMemoryDocumentProvider,
  emptyDoc,
  getDocumentProvider,
  onDocumentProviderChange,
  type DocJSON,
  type DocumentProvider,
} from '@/shared/document'
import { useStore, type RecentProject } from '@/shared/store'
import { openProjectIndex, recordRevision, type ProjectIndex } from './db'
import { askUnsavedChanges, pickFolder, showError } from './dialogs'
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
  pathExists,
  readRecentRaw,
  readTextFile,
  setProjectRoot,
  setRecentMenu,
  writeFileAtomic,
  writeRecentRaw,
} from './ipc'
import { addRecent, flagMissing, parseRecentFile, serializeRecent } from './recent'
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

/**
 * Used only until an editor registers a DocumentProvider (e.g. before the
 * editor slice is wired in), so New/Open/Save still round-trip the document.
 */
const fallbackProvider = createMemoryDocumentProvider()

function provider(): DocumentProvider {
  return getDocumentProvider() ?? fallbackProvider
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

async function activate(folder: string, meta: ProjectMeta, doc: DocJSON, index: ProjectIndex | null) {
  await closeIndex()
  currentMeta = meta
  currentIndex = index
  const p = provider()
  p.setDocJSON(doc)
  p.markClean()
  lastSaveDoneAt = 0
  actions().projectOpened({ path: folder, title: meta.title })
  openedListeners.forEach((cb) => cb({ path: folder, meta }))
  await rememberRecent({ path: folder, name: meta.title, openedAt: new Date().toISOString() })
}

/**
 * Confine Rust file access to `folder` while `fn` runs. If `fn` fails, the
 * previous project's folder is restored so the open project can still save.
 */
async function withProjectRoot(folder: string, fn: () => Promise<void>): Promise<void> {
  const previous = getCurrentProjectPath()
  await setProjectRoot(folder)
  try {
    await fn()
  } catch (e) {
    await setProjectRoot(previous).catch((err) => console.warn('Restoring the project folder failed:', err))
    throw e
  }
}

/** Create a new project in an existing folder, initialised with `doc`. Throws ProjectError. */
export async function createProjectAt(folder: string, doc: DocJSON = emptyDoc()): Promise<void> {
  if (!(await pathExists(folder))) {
    throw new ProjectError('missing-folder', `The folder could not be found:\n${folder}`)
  }
  await withProjectRoot(folder, () => createProjectIn(folder, doc))
}

async function createProjectIn(folder: string, doc: DocJSON): Promise<void> {
  if (await pathExists(joinPath(folder, PROJECT_FILE))) {
    throw new ProjectError(
      'already-exists',
      `This folder already contains a Novel project. Use Open Project to open it, or choose an empty folder.`,
    )
  }
  const meta = newProjectMeta(baseName(folder))
  await writeFileAtomic(joinPath(folder, MANUSCRIPT_FILE), serializeManuscript(doc), MANUSCRIPT_FILE)
  await writeFileAtomic(joinPath(folder, PROJECT_FILE), serializeProjectMeta(meta), PROJECT_FILE)
  const index = await openIndexSafely(folder)
  await activate(folder, meta, doc, index)
}

/** Open the project in `folder`. Throws ProjectError for missing/corrupt files. */
export async function openProjectAt(folder: string): Promise<void> {
  if (!(await pathExists(folder))) {
    throw new ProjectError('missing-folder', `The project folder could not be found:\n${folder}`)
  }
  await withProjectRoot(folder, () => openProjectIn(folder))
}

async function openProjectIn(folder: string): Promise<void> {
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
  const doc = parseManuscript(docText)
  const index = await openIndexSafely(folder)
  await activate(folder, meta, doc, index)
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
  const p = provider()
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
  let changedDuringSave = false
  const off = p.onDocChange(() => {
    changedDuringSave = true
  })
  try {
    const text = serializeManuscript(p.getDocJSON())
    await writeFileAtomic(joinPath(folder, MANUSCRIPT_FILE), text, MANUSCRIPT_FILE)
    const updated: ProjectMeta = { ...meta, updatedAt: new Date().toISOString() }
    await writeFileAtomic(joinPath(folder, PROJECT_FILE), serializeProjectMeta(updated), PROJECT_FILE)
    if (currentMeta === meta) currentMeta = updated
    if (!changedDuringSave) p.markClean()
    if (currentIndex) {
      const byteSize = new TextEncoder().encode(text).length
      await recordRevision(currentIndex, { kind, byteSize, path: MANUSCRIPT_FILE }).catch((e) =>
        console.warn('Recording revision failed:', e),
      )
    }
    lastSaveDoneAt = Date.now()
    actions().saveSucceeded(lastSaveDoneAt)
    actions().setDirty(p.isDirty())
    return true
  } catch (e) {
    const msg = e instanceof ProjectError ? e.message : 'The project could not be saved.'
    actions().saveFailed(msg)
    if (!silent) await showError('Could not save', e)
    return false
  } finally {
    off()
  }
}

async function saveAsNewProject(): Promise<boolean> {
  try {
    const folder = await pickFolder('Choose a folder for your project')
    if (!folder) return false
    await createProjectAt(folder, provider().getDocJSON())
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
  if (!provider().isDirty()) return true
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
    const folder = await pickFolder('Choose a folder for the new project')
    if (!folder) return false
    await createProjectAt(folder, emptyDoc())
    return true
  } catch (e) {
    await showError('Could not create project', e)
    return false
  }
}

/** Menu action: File > Open Project... (or open `folder` directly, e.g. from Open Recent). */
export async function openProject(folder?: string): Promise<boolean> {
  if (!(await confirmUnsavedChanges('opening another project'))) return false
  let target = folder ?? null
  try {
    target ??= await pickFolder('Open a Novel project folder')
    if (!target) return false
    await openProjectAt(target)
    return true
  } catch (e) {
    if (target && e instanceof ProjectError && (e.code === 'missing-folder' || e.code === 'not-a-project')) {
      const recent = useStore.getState().project.recent
      await persistRecent(flagMissing(recent, target, true))
    }
    await showError('Could not open project', e)
    return false
  }
}

/** Close the open project (no prompt; call confirmUnsavedChanges first). */
export async function closeProject(): Promise<void> {
  await closeIndex()
  await setProjectRoot(null).catch((e) => console.warn('Clearing the project folder failed:', e))
  currentMeta = null
  lastSaveDoneAt = 0
  actions().projectClosed()
}

// ---- Recent projects -------------------------------------------------------

async function syncRecentMenu(list: RecentProject[]): Promise<void> {
  try {
    await setRecentMenu(list.map((r) => ({ path: r.path, label: `${r.name} (${r.path})`, missing: !!r.missing })))
  } catch (e) {
    console.warn('Updating the Open Recent menu failed:', e)
  }
}

async function persistRecent(list: RecentProject[]): Promise<void> {
  actions().setRecent(list)
  try {
    await writeRecentRaw(serializeRecent(list))
  } catch (e) {
    console.warn('Saving the recent-projects list failed:', e)
  }
  await syncRecentMenu(list)
}

async function rememberRecent(entry: RecentProject): Promise<void> {
  await persistRecent(addRecent(useStore.getState().project.recent, entry))
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

/** Mirror the provider's dirty flag into the store. Returns a disposer. */
export function trackDirtyState(): () => void {
  let offDoc: (() => void) | null = null
  const attach = () => {
    offDoc?.()
    const p = provider()
    const sync = () => actions().setDirty(p.isDirty())
    offDoc = p.onDocChange(sync)
    sync()
  }
  attach()
  const offProvider = onDocumentProviderChange(attach)
  return () => {
    offProvider()
    offDoc?.()
  }
}

/** Test-only: reset module state. */
export async function __resetStorageForTests(): Promise<void> {
  await closeIndex()
  currentMeta = null
  inFlightSave = null
  lastSaveDoneAt = 0
  openedListeners.clear()
}
