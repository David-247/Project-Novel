import { defaultBookSettings, newProjectBookSettings, type BookSettings } from '@/shared/book'
import { emptyDoc, getDocumentProvider, isEmptyDocJSON, type DocJSON, type DocumentProvider } from '@/shared/document'
import { useStore, type RecentProject } from '@/shared/store'
import {
  BOOK_FILE,
  bookWarningText,
  currentBookSettings,
  getBookVersion,
  isBookDirty,
  parseBook,
  serializeBook,
} from './book-file'
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
  probeRecentRecovery,
  readRecentRaw,
  readTextFile,
  rememberRecentRaw,
  restoreProjectRoot,
  setRecentMenu,
  writeFileAtomic,
} from './ipc'
import { flagMissing, parseRecentFile } from './recent'
import {
  deleteRecoveryFile,
  judgeRecovery,
  listUnrestoredFiles,
  parseRecovery,
  readRecoveryFile,
  RECOVERY_DIR,
  recoveryFilePath,
  suppressSnapshotsAt,
  writeUnrestoredFile,
  type RecoverySnapshot,
} from './recovery'
import type { RevisionKind } from './schema'
import { withWriteLock } from './write-lock'

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
/** Recovery snapshot found when the open project was opened, awaiting Restore / Discard. */
type PendingRecovery = { folder: string; snapshot: RecoverySnapshot; text: string }
let pendingRecovery: PendingRecovery | null = null

/** Set the unanswered snapshot; the store mirrors it for the status-bar "Backup available" control. */
function setPendingRecovery(p: PendingRecovery | null): void {
  pendingRecovery = p
  if (useStore.getState().project.pendingRecoveryAt !== (p?.snapshot.savedAt ?? null)) {
    actions().setPendingRecovery(p?.snapshot.savedAt ?? null)
  }
}
const openedListeners = new Set<(p: OpenedProject) => void>()
const leftUnsavedListeners = new Set<() => void>()

/**
 * Subscribe to "a save succeeded but the project is still unsaved" (book settings that could not be
 * written, edits made during the save). The save moved project.json `updatedAt`, so the last recovery
 * snapshot no longer matches the current save: autosave must take a fresh one. Returns unsubscribe.
 */
export function onSaveLeftUnsaved(cb: () => void): () => void {
  leftUnsavedListeners.add(cb)
  return () => leftUnsavedListeners.delete(cb)
}

/** The registered editor; storage cannot work without one. */
function provider(): DocumentProvider {
  const p = getDocumentProvider()
  if (!p) throw new ProjectError('no-editor', 'The editor is not ready yet. Please try again in a moment.')
  return p
}

const actions = () => useStore.getState().projectActions
const bookActions = () => useStore.getState().bookActions

/** Unsaved changes in the manuscript OR the book settings (both count as "the project is unsaved"). */
function isProjectDirty(p: DocumentProvider): boolean {
  return p.isDirty() || isBookDirty()
}

/**
 * Read book.json: a missing file (Phase 1 project) gives defaults silently; a damaged or unreadable one
 * gives defaults plus a status warning; one from a newer Novel gives its settings (as far as they are
 * understood) plus a warning, and is guarded like a damaged one. manuscript.json is never touched.
 */
async function readBookFile(folder: string): Promise<{
  settings: BookSettings
  warning: string | null
  guard: BookGuard | null
}> {
  let text: string
  try {
    text = await readTextFile(joinPath(folder, BOOK_FILE), BOOK_FILE)
  } catch (e) {
    if (e instanceof ProjectError && e.code === 'missing-file') {
      return { settings: defaultBookSettings(), warning: null, guard: null }
    }
    console.warn('Reading book.json failed:', e)
    // The real file may be fine (antivirus / sync lock): never replace it with defaults on a text-only save.
    return {
      settings: defaultBookSettings(),
      warning: bookWarningText(['the whole file'], true),
      guard: { original: null, kind: 'damaged', loaded: guardKey(defaultBookSettings()) },
    }
  }
  const { settings, warnings, newerVersion } = parseBook(text)
  if (newerVersion !== undefined) {
    // Written by a newer Novel: rewriting it would drop what this version does not know (nested keys
    // included), so it is only replaced once the user changes a book setting, after a copy is kept.
    return {
      settings,
      warning: bookWarningText(warnings, true, newerVersion),
      guard: { original: text, kind: 'newer', loaded: guardKey(settings) },
    }
  }
  const whole = warnings.length === 1 && warnings[0] === 'the whole file'
  return {
    settings,
    warning: warnings.length ? bookWarningText(warnings, whole) : null,
    guard: whole ? { original: text, kind: 'damaged', loaded: guardKey(settings) } : null,
  }
}

/**
 * book.json was unreadable, wholly damaged, or from a newer Novel when opened: saves leave it alone until the
 * user changes a book setting. `original` is its text if it could be read (null: read failed, retried before
 * the first overwrite). `kind` names the copy kept aside (`book.damaged-*` / `book.newer-*`).
 */
interface BookGuard {
  original: string | null
  kind: 'damaged' | 'newer'
  /** `guardKey` of the settings loaded at open: a real book change is a difference from it. */
  loaded: string
}
let bookGuard: BookGuard | null = null

/**
 * Book settings compared for "a real book change" while book.json is guarded: everything but the page
 * view and the paper surface. Those two are display toggles: switching them never replaces a guarded
 * book.json (while it is guarded they are not written; docs/project-format.md).
 */
function guardKey(settings: BookSettings): string {
  const d = defaultBookSettings()
  return serializeBook({ ...settings, view: d.view, surface: d.surface })
}

/** The guarded book.json may be replaced: a book setting other than view / surface differs from the file's. */
function guardedBookChanged(guard: BookGuard): boolean {
  return guardKey(currentBookSettings()) !== guard.loaded
}

/** The book settings are the defaults, apart from view and surface. */
function onlyDisplayTogglesChanged(): boolean {
  return guardKey(currentBookSettings()) === guardKey(defaultBookSettings())
}

/** Status-bar text when the copy of a guarded book.json could not be kept (book.json was then not replaced). */
const GUARD_COPY_FAILED =
  `Your book settings were not saved: Novel could not keep a copy of the existing ${BOOK_FILE} before replacing it, ` +
  `so ${BOOK_FILE} was left as it is. The manuscript was saved. Saving again will retry.`

/**
 * Copy the guarded book.json aside as `book.damaged-<timestamp>.json` (damaged / unreadable) or
 * `book.newer-<timestamp>.json` (from a newer Novel). Never throws: resolves false when no copy could be
 * kept, and the caller must then not replace book.json. A file that is gone has nothing to keep (true).
 */
async function keepGuardedBook(folder: string, guard: BookGuard): Promise<boolean> {
  try {
    let original = guard.original
    if (original === null) {
      try {
        original = await readTextFile(joinPath(folder, BOOK_FILE), BOOK_FILE)
      } catch (e) {
        if (e instanceof ProjectError && e.code === 'missing-file') return true
        throw e
      }
    }
    const stamp = new Date().toISOString().replace(/[^0-9A-Za-z-]/g, '-')
    await writeFileAtomic(joinPath(folder, `book.${guard.kind}-${stamp}.json`), original, 'book.json copy')
    return true
  } catch (e) {
    console.warn(`Keeping a copy of the ${guard.kind} book.json failed; it is not replaced:`, e)
    return false
  }
}

/** Absolute path of the open project folder, or null. */
export function getCurrentProjectPath(): string | null {
  return useStore.getState().project.path
}

/** Metadata (project.json) of the open project, or null. */
export function getCurrentProjectMeta(): ProjectMeta | null {
  return currentMeta
}

/**
 * Change the open project's title and/or author ("Book details"). project.json is rewritten at once
 * (atomically, under the write lock) rather than waiting for the next save, so a crash cannot lose
 * it and it needs no unsaved-changes bookkeeping. Resolves false when no project is open, nothing
 * changed, or the write failed (an error dialog is shown). A blank title keeps the old one.
 *
 * `updatedAt` is NOT changed: it means "the last save" (docs/project-format.md), and crash recovery
 * matches a snapshot to that save by `baseUpdatedAt`. A details edit is not a save of the manuscript,
 * so bumping it would make every snapshot taken before the edit look like it belongs to another save.
 */
export async function updateProjectDetails(details: { title?: string; author?: string }): Promise<boolean> {
  const folder = getCurrentProjectPath()
  const meta = currentMeta
  if (!folder || !meta) return false
  const title = details.title === undefined || !details.title.trim() ? meta.title : details.title.trim()
  const author = details.author === undefined ? meta.author : details.author.trim()
  if (title === meta.title && author === meta.author) return true
  try {
    await withWriteLock(async () => {
      const base = currentMeta && currentMeta.id === meta.id ? currentMeta : meta
      const updated: ProjectMeta = { ...base, title, author }
      await writeFileAtomic(joinPath(folder, PROJECT_FILE), serializeProjectMeta(updated), PROJECT_FILE)
      if (currentMeta === base) currentMeta = updated
    })
  } catch (e) {
    await showError('Could not save the book details', e)
    return false
  }
  if (getCurrentProjectPath() !== folder) return true
  actions().projectDetailsChanged({ title, author })
  await rememberRecent(title)
  return true
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

/**
 * Close the previous project's index, then open `folder`'s. Call only after the
 * last step that can fail: the SQL plugin keys connections by URL, so reopening
 * the same project must close the old pool BEFORE loading the new one (closing
 * afterwards would close the new pool).
 */
async function switchIndex(folder: string): Promise<ProjectIndex | null> {
  await closeIndex()
  return openIndexSafely(folder)
}

/** Switch module + store state to the project in `folder` (files read/written, index switched). */
async function activate(folder: string, meta: ProjectMeta, index: ProjectIndex | null) {
  currentMeta = meta
  currentIndex = index
  bookGuard = null
  lastSaveDoneAt = 0
  setPendingRecovery(null)
  suppressSnapshotsAt(null)
  actions().projectOpened({ path: folder, title: meta.title, author: meta.author })
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
  // Never overwrite leftovers of a project whose project.json is gone.
  for (const file of [MANUSCRIPT_FILE, BOOK_FILE, INDEX_FILE]) {
    if (await pathExists(joinPath(folder, file))) {
      throw new ProjectError(
        'already-exists',
        `This folder already contains ${file} from an earlier project, and Novel will not overwrite it. ` +
          `Choose an empty folder for the new project.`,
      )
    }
  }
  const version = p.getDocVersion()
  const content = doc ?? p.getDocJSON()
  const meta = newProjectMeta(baseName(folder))
  await writeFileAtomic(joinPath(folder, MANUSCRIPT_FILE), serializeManuscript(content), MANUSCRIPT_FILE)
  // A new project starts with the default book settings plus the user's new-project preferences
  // (paper, trim size); Save As keeps the current ones.
  const book = doc ? newProjectBookSettings(useStore.getState().preferences) : currentBookSettings()
  const bookVersion = getBookVersion()
  await writeFileAtomic(joinPath(folder, BOOK_FILE), serializeBook(book), BOOK_FILE)
  await writeFileAtomic(joinPath(folder, PROJECT_FILE), serializeProjectMeta(meta), PROJECT_FILE)
  if (doc) {
    loadDocument(p, doc)
    bookActions().loadBook(book)
  } else {
    p.markClean(version)
    bookActions().markBookClean(bookVersion)
  }
  await activate(folder, meta, await switchIndex(folder))
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
  const book = await readBookFile(folder)
  loadDocument(p, parseManuscript(docText))
  bookActions().loadBook(book.settings)
  await activate(folder, meta, await switchIndex(folder))
  bookGuard = book.guard
  actions().setBookWarning(book.warning)
  await detectRecovery(folder, meta, docText, book.settings)
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
  if (kind === 'manual' && !isProjectDirty(p) && Date.now() - lastSaveDoneAt < SAVE_COALESCE_MS) {
    return Promise.resolve(true)
  }
  inFlightSave = writeProject(folder, currentMeta, p, kind, opts.silent ?? false).finally(() => {
    inFlightSave = null
  })
  return inFlightSave
}

/** True while a save of the project is in progress (or queued behind a snapshot). */
export function isSaveInFlight(): boolean {
  return inFlightSave !== null
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
    // The content is taken when Save is requested. Version read before the doc:
    // edits made during the async write keep the doc dirty.
    const version = p.getDocVersion()
    const text = serializeManuscript(p.getDocJSON())
    const bookVersion = getBookVersion()
    const bookText = serializeBook(currentBookSettings())
    // The write lock keeps this from overlapping an autosave snapshot.
    await withWriteLock(async () => {
      await writeFileAtomic(joinPath(folder, MANUSCRIPT_FILE), text, MANUSCRIPT_FILE)
      // An unreadable / damaged / newer book.json is only replaced once the user changed a book setting
      // other than view / surface, and only after a copy of it was kept.
      let bookSaved = true
      if (!bookGuard || (isBookDirty() && guardedBookChanged(bookGuard))) {
        if (bookGuard && !(await keepGuardedBook(folder, bookGuard))) {
          bookSaved = false
          actions().setBookWarning(GUARD_COPY_FAILED)
        } else {
          await writeFileAtomic(joinPath(folder, BOOK_FILE), bookText, BOOK_FILE)
          bookGuard = null
          actions().setBookWarning(null)
        }
      }
      // Book details may have been edited while this save was queued: write the latest of this project.
      const base = currentMeta && currentMeta.id === meta.id ? currentMeta : meta
      const updated: ProjectMeta = { ...base, updatedAt: new Date().toISOString() }
      await writeFileAtomic(joinPath(folder, PROJECT_FILE), serializeProjectMeta(updated), PROJECT_FILE)
      if (currentMeta === base) currentMeta = updated
      p.markClean(version)
      // Book settings that could not be written stay unsaved (prompts, autosave snapshots keep them).
      if (bookSaved) bookActions().markBookClean(bookVersion)
      // A clean save makes any crash-recovery snapshot obsolete.
      if (!isProjectDirty(p)) await clearRecoveryUnlocked(folder)
    })
    // Still unsaved after the save: the snapshot on disk was taken on top of the previous save.
    if (isProjectDirty(p) && getCurrentProjectPath() === folder) leftUnsavedListeners.forEach((cb) => cb())
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

/**
 * True while a New / Open / Save-As flow (prompt + folder dialog + load) runs.
 * A second request meanwhile is ignored: the Rust root has one "previous" slot,
 * so overlapping flows could restore the wrong folder.
 */
let folderFlowBusy = false

async function exclusiveFolderFlow(fn: () => Promise<boolean>): Promise<boolean> {
  if (folderFlowBusy) return false
  folderFlowBusy = true
  try {
    return await fn()
  } finally {
    folderFlowBusy = false
  }
}

function saveAsNewProject(): Promise<boolean> {
  return exclusiveFolderFlow(saveAsNewProjectUnguarded)
}

async function saveAsNewProjectUnguarded(): Promise<boolean> {
  try {
    provider()
    const folder = await pickProjectFolder('Choose a folder for your project')
    if (!folder) return false
    await whileOpening(() => inGrantedRoot(() => createProjectAt(folder, null)))
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
  if (!p || !isProjectDirty(p)) return true
  // An untitled session whose document is empty and whose book settings are the defaults, apart from the
  // page view and the paper surface, has nothing worth a prompt: those two are display toggles. Any other
  // book change (trim, margins, styles, footnote or header/footer options) works without a project and
  // is worth saving, so it still prompts.
  if (!getCurrentProjectPath() && isEmptyDocJSON(p.getDocJSON()) && onlyDisplayTogglesChanged()) return true
  try {
    const choice = await askUnsavedChanges(useStore.getState().project.title, action)
    if (choice === 'save') {
      // Inside a New/Open flow with no project yet, Save is a Save-As that belongs to that flow.
      if (folderFlowBusy && !getCurrentProjectPath()) return await saveAsNewProjectUnguarded()
      return await saveProject()
    }
    if (choice === 'discard') await discardUnsavedForRecovery(p)
    return choice === 'discard'
  } catch (e) {
    // The native dialog failed: never trap the user (e.g. unable to close).
    // Ask with the webview's own confirm; the recovery snapshot is kept either way.
    console.error('Unsaved-changes prompt failed:', e)
    return fallbackConfirm(`You have unsaved changes. Continue ${action} without saving them?`)
  }
}

function fallbackConfirm(text: string): boolean {
  try {
    return window.confirm(text)
  } catch (e) {
    console.error('Fallback confirm failed; proceeding:', e)
    return true
  }
}

/**
 * Run a create/open step with the "Opening…" state on (status bar; editor read-only), on every
 * path: New Project, Save As, Open Project, Open Recent, Reopen after a crash.
 */
async function whileOpening(fn: () => Promise<void>): Promise<void> {
  actions().openStarted()
  try {
    await fn()
  } finally {
    actions().openFinished()
  }
}

/** Menu action: File > New Project. */
export function newProject(): Promise<boolean> {
  return exclusiveFolderFlow(newProjectUnguarded)
}

async function newProjectUnguarded(): Promise<boolean> {
  if (!(await confirmUnsavedChanges('creating a new project'))) return false
  try {
    provider()
    const folder = await pickProjectFolder('Choose a folder for the new project')
    if (!folder) return false
    await whileOpening(() => inGrantedRoot(() => createProjectAt(folder, emptyDoc())))
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
export function openProject(folder?: string): Promise<boolean> {
  return exclusiveFolderFlow(() => openProjectUnguarded(folder))
}

async function openProjectUnguarded(folder?: string): Promise<boolean> {
  if (!(await confirmUnsavedChanges('opening another project'))) return false
  let target = folder ?? null
  try {
    provider()
    if (target) await openRecentRoot(target)
    else target = await pickProjectFolder('Open a Novel project folder')
    if (!target) return false
    const granted = target
    await whileOpening(() => inGrantedRoot(() => openProjectAt(granted)))
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
  pendingRecovery = null
  bookGuard = null
  bookActions().resetBook()
  actions().projectClosed()
}

// ---- Crash recovery ---------------------------------------------------------

/** Status note after an unanswered backup was moved aside during this session. */
export const SET_ASIDE_NOTICE = `The earlier backup was kept in this project's ${RECOVERY_DIR} folder (unrestored file).`

/** Status note on open when set-aside backups exist (docs/project-format.md explains recovering them). */
export function unrestoredNotice(count: number): string {
  return count === 1
    ? `1 older backup is kept in this project's ${RECOVERY_DIR} folder.`
    : `${count} older backups are kept in this project's ${RECOVERY_DIR} folder.`
}
//
// Rule: Novel never silently destroys a snapshot the user has not answered.
// Only a snapshot that is identical to the manuscript, or one the user
// explicitly discarded / saved over / chose "Don't Save" for after answering,
// is deleted. Anything else is moved aside to `.recovery/unrestored-<savedAt>.json`.

/**
 * If the snapshot of `folder` is still unanswered (Restore / Discard), move it
 * aside before it is overwritten or deleted. Throws if it cannot be kept, so
 * the caller must not go on to overwrite/delete. Caller holds the write lock.
 */
export async function preserveUnansweredRecoveryUnlocked(folder: string): Promise<void> {
  const pending = pendingRecovery
  if (!pending || pending.folder !== folder) return
  await writeUnrestoredFile(folder, pending.snapshot.savedAt, pending.text)
  setPendingRecovery(null)
  if (useStore.getState().project.recoveryPrompt?.kind === 'restore') actions().dismissRecoveryPrompt()
  if (getCurrentProjectPath() === folder) actions().setRecoveryNotice(SET_ASIDE_NOTICE)
}

/**
 * Delete recovery data of `folder`; never throws. Caller holds the write lock.
 * An unanswered snapshot is moved aside first unless `discard` (the user chose Discard Backup).
 */
async function clearRecoveryUnlocked(folder: string, discard = false): Promise<void> {
  try {
    if (!discard) await preserveUnansweredRecoveryUnlocked(folder)
    await deleteRecoveryFile(folder)
  } catch (e) {
    // Kept on disk: a leftover snapshot is never offered unless it matches the current save.
    console.warn('Deleting recovery data failed; it was kept:', e)
    return
  }
  if (pendingRecovery?.folder === folder) setPendingRecovery(null)
  if (getCurrentProjectPath() === folder) actions().backupCleared()
}

/**
 * Delete the open project's crash-recovery data (after a clean quit, or when
 * the user chose "Don't Save"). Waits for any in-flight write. An unanswered
 * snapshot is moved aside, never deleted. Never throws.
 */
export function clearRecoveryData(): Promise<void> {
  const folder = getCurrentProjectPath()
  if (!folder) return Promise.resolve()
  return withWriteLock(() => clearRecoveryUnlocked(folder))
}

/** "Don't Save": drop recovery data and do not snapshot the discarded content again. */
async function discardUnsavedForRecovery(p: DocumentProvider): Promise<void> {
  suppressSnapshotsAt(p.getDocVersion(), getBookVersion())
  await clearRecoveryData()
}

/** Move a snapshot that is not offered (and not identical) aside; never throws. Caller holds the lock. */
async function setAsideUnlocked(folder: string, snapshot: RecoverySnapshot, text: string): Promise<void> {
  try {
    await writeUnrestoredFile(folder, snapshot.savedAt, text)
    await deleteRecoveryFile(folder)
  } catch (e) {
    console.warn('Moving old recovery data aside failed; it was left in place:', e)
  }
}

/**
 * After opening `folder`, decide what to do with `.recovery/manuscript.json`
 * (see judgeRecovery): offer Restore / Discard, delete it (identical to the
 * manuscript), or move it aside (cannot tell it belongs to the current save).
 * A damaged snapshot is left in place. Never throws: recovery must not stop a
 * project from opening.
 */
async function detectRecovery(
  folder: string,
  meta: ProjectMeta,
  manuscriptText: string,
  savedBook: BookSettings,
): Promise<void> {
  await judgeFoundRecovery(folder, meta, manuscriptText, savedBook)
  await noteUnrestoredFiles(folder)
}

async function judgeFoundRecovery(
  folder: string,
  meta: ProjectMeta,
  manuscriptText: string,
  savedBook: BookSettings,
): Promise<void> {
  try {
    const text = await readRecoveryFile(folder)
    if (text === null) return
    const snapshot = parseRecovery(text)
    if (!snapshot) {
      console.warn('Ignoring unreadable recovery data in', recoveryFilePath(folder))
      return
    }
    const verdict = judgeRecovery(snapshot, meta, manuscriptText, savedBook)
    if (verdict === 'identical') {
      await withWriteLock(() => clearRecoveryUnlocked(folder, true))
    } else if (verdict === 'unrelated') {
      await withWriteLock(() => setAsideUnlocked(folder, snapshot, text))
    } else {
      setPendingRecovery({ folder, snapshot, text })
      actions().showRecoveryPrompt({ kind: 'restore', savedAt: snapshot.savedAt })
    }
  } catch (e) {
    console.warn('Checking for recovery data failed:', e)
  }
}

/** Mention set-aside `unrestored-*.json` backups once, in the status bar (no dialog). Never throws. */
async function noteUnrestoredFiles(folder: string): Promise<void> {
  try {
    const count = (await listUnrestoredFiles(folder)).length
    if (count > 0 && getCurrentProjectPath() === folder) actions().setRecoveryNotice(unrestoredNotice(count))
  } catch (e) {
    console.warn('Looking for set-aside backups failed:', e)
  }
}

/**
 * "Backup available — Restore…": show the Restore / Discard question again for the backup that
 * is still unanswered (after "Decide later"). Returns false if there is none any more.
 */
export function reopenRecoveryPrompt(): boolean {
  const pending = pendingRecovery
  if (!pending || pending.folder !== getCurrentProjectPath()) return false
  actions().showRecoveryPrompt({ kind: 'restore', savedAt: pending.snapshot.savedAt })
  return true
}

/**
 * Restore: load the snapshot into the editor and leave it unsaved (the user
 * decides whether to save it). The recovery file is kept until then, so a
 * second crash still recovers it.
 */
export async function restoreRecovery(): Promise<boolean> {
  const pending = pendingRecovery
  actions().dismissRecoveryPrompt()
  if (!pending || pending.folder !== getCurrentProjectPath()) return false
  try {
    const p = provider()
    loadDocument(p, pending.snapshot.doc)
    p.markDirty()
    // Unsaved book settings come back with the text (snapshots from before book settings have none).
    // Only when they differ: restoring equal settings would mark the book unsaved, and the next save would
    // then replace a guarded (newer / damaged) book.json after a text-only restore.
    const book = pending.snapshot.book
    if (book && serializeBook(book) !== serializeBook(currentBookSettings())) bookActions().restoreBook(book)
    setPendingRecovery(null)
    // The editor content is exactly what the recovery file holds: it is backed up.
    const savedAt = Date.parse(pending.snapshot.savedAt)
    actions().backupSucceeded(Number.isNaN(savedAt) ? Date.now() : savedAt)
    return true
  } catch (e) {
    await showError(
      'Could not restore',
      e instanceof ProjectError && e.code === 'corrupt-file'
        ? new ProjectError('corrupt-file', 'The backup copy contains content Novel cannot display, so it was not restored.')
        : e,
    )
    return false
  }
}

/** True while a recovery snapshot found on open has not been restored or discarded. */
export function hasPendingRecovery(): boolean {
  return pendingRecovery !== null && pendingRecovery.folder === getCurrentProjectPath()
}

/** Discard: delete the snapshot and keep the manuscript as saved. */
export async function discardRecovery(): Promise<void> {
  const pending = pendingRecovery
  actions().dismissRecoveryPrompt()
  setPendingRecovery(null)
  if (pending && pending.folder === getCurrentProjectPath()) {
    await withWriteLock(() => clearRecoveryUnlocked(pending.folder, true))
  }
}

/**
 * At startup (no project open yet): if the most recent project has a snapshot
 * that would be offered on open (same rule as detectRecovery), offer to reopen
 * it. Never throws.
 */
export async function offerReopenAfterCrash(recent: RecentProject[]): Promise<void> {
  try {
    const last = recent[0]
    if (!last || last.missing || getCurrentProjectPath()) return
    const probe = await probeRecentRecovery(last.path)
    if (!probe.project || !probe.recovery) return
    const snapshot = parseRecovery(probe.recovery)
    if (!snapshot || judgeRecovery(snapshot, parseProjectMeta(probe.project)) !== 'offer') return
    if (getCurrentProjectPath() || useStore.getState().project.recoveryPrompt) return
    actions().showRecoveryPrompt({ kind: 'reopen', path: last.path, name: last.name })
  } catch (e) {
    console.warn('Checking the last project for recovery data failed:', e)
  }
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
  pendingRecovery = null
  folderFlowBusy = false
  bookGuard = null
  suppressSnapshotsAt(null)
  openedListeners.clear()
}
