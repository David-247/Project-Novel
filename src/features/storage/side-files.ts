import { joinPath, ProjectError } from './format'
import { readTextFile, writeFileAtomic, type BatchFile } from './ipc'

/**
 * Project side files: named JSON files beside manuscript.json that belong to a feature slice
 * (`comments.json`; later `rewrites.json`). docs/project-format.md, "Side files".
 *
 * Storage owns the file: reading on open, writing with every save in the same batch as the
 * manuscript (Rust `storage_write_files_atomic`: everything staged before anything is replaced),
 * crash-recovery snapshots, and the guard for a damaged or newer file. The slice owns the content:
 * it gets the parsed JSON on open and hands back a JSON value to write. Unknown keys are the
 * slice's to keep (it must write back what it did not understand).
 */
export interface ProjectSideFile {
  /** File name beside manuscript.json, e.g. `comments.json` (lowercase letters, digits, dashes). */
  name: string
  /**
   * The file's parsed JSON (null: no file, a damaged one, or a new project). Called after the
   * manuscript was loaded into the editor. Return `{ newer: version }` when the data was written by a
   * newer Novel: it is used as far as understood, and the file is guarded (below). Must not throw.
   */
  load(data: unknown | null): { newer?: number } | void
  /** The current content. `empty`: nothing worth a file (a missing file is then not created). */
  serialize(): { data: unknown; empty: boolean }
  /** Bumps on every change the user makes (not on load). A guarded file is replaced only after one. */
  getVersion(): number
  /**
   * Content to write when the project is closed while saved (unsaved-changes prompt answered or
   * nothing unsaved), or null when closing changes nothing. For data that only matters within a
   * session (comments: threads whose anchor text is gone are pruned on close).
   */
  closeData?(): unknown | null
}

/** A damaged / unreadable / newer side file: not replaced until a real change, copied aside first. */
interface SideGuard {
  kind: 'damaged' | 'newer'
  /** The file's text (null: it could not be read; read again before the copy). */
  original: string | null
  /** `getVersion()` right after load: a real change is a different version. */
  loadedVersion: number
}

interface Entry {
  file: ProjectSideFile
  /** The file exists in the project folder (read on open, or written since). */
  present: boolean
  guard: SideGuard | null
}

const entries = new Map<string, Entry>()

/** Register a side file (once per slice, at app start). Returns unregister. */
export function registerSideFile(file: ProjectSideFile): () => void {
  if (!/^[a-z0-9-]+\.json$/.test(file.name)) throw new Error(`Invalid side file name: ${file.name}`)
  const entry: Entry = { file, present: false, guard: null }
  entries.set(file.name, entry)
  return () => {
    if (entries.get(file.name) === entry) entries.delete(file.name)
  }
}

/** Names of the registered side files (New Project refuses folders holding one without project.json). */
export function sideFileNames(): string[] {
  return [...entries.keys()]
}

export function sideFileWarningText(name: string, kind: 'damaged' | 'newer', version?: number): string {
  return kind === 'newer'
    ? `${name} was saved by a newer version of Novel (format version ${version}), so it is used as far as this version understands it. ` +
        `The file is left as it is until you change it; a copy is kept before it is replaced.`
    : `${name} is damaged or could not be read, so it is treated as empty. Your manuscript was not changed. ` +
        `The file is left as it is until you change it; a copy is kept before it is replaced.`
}

/**
 * Read every registered side file of `folder` and load it into its slice. A missing file loads as
 * null (Phase 1 and 2 projects). Never throws: returns status-bar warnings for damaged / newer files.
 */
export async function loadSideFiles(folder: string): Promise<string[]> {
  const warnings: string[] = []
  for (const entry of entries.values()) {
    const { file } = entry
    entry.guard = null
    entry.present = false
    let text: string
    try {
      text = await readTextFile(joinPath(folder, file.name), file.name)
    } catch (e) {
      if (e instanceof ProjectError && e.code === 'missing-file') {
        safeLoad(file, null)
        continue
      }
      // The real file may be fine (locked by antivirus or a sync tool): never replace it unasked.
      console.warn(`Reading ${file.name} failed:`, e)
      entry.present = true
      safeLoad(file, null)
      entry.guard = { kind: 'damaged', original: null, loadedVersion: file.getVersion() }
      warnings.push(sideFileWarningText(file.name, 'damaged'))
      continue
    }
    entry.present = true
    let data: unknown
    try {
      data = JSON.parse(text)
    } catch {
      data = undefined
    }
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      safeLoad(file, null)
      entry.guard = { kind: 'damaged', original: text, loadedVersion: file.getVersion() }
      warnings.push(sideFileWarningText(file.name, 'damaged'))
      continue
    }
    const result = safeLoad(file, data)
    if (result === 'failed') {
      entry.guard = { kind: 'damaged', original: text, loadedVersion: file.getVersion() }
      warnings.push(sideFileWarningText(file.name, 'damaged'))
    } else if (result && result.newer !== undefined) {
      entry.guard = { kind: 'newer', original: text, loadedVersion: file.getVersion() }
      warnings.push(sideFileWarningText(file.name, 'newer', result.newer))
    }
  }
  return warnings
}

function safeLoad(file: ProjectSideFile, data: unknown | null): { newer?: number } | void | 'failed' {
  try {
    return file.load(data)
  } catch (e) {
    console.warn(`Loading ${file.name} failed:`, e)
    try {
      file.load(null)
    } catch {
      // nothing more to do
    }
    return 'failed'
  }
}

/** Empty side files for a new project (New Project); Save As keeps the current content. */
export function resetSideFiles(load: boolean): void {
  for (const entry of entries.values()) {
    entry.guard = null
    entry.present = false
    if (load) safeLoad(entry.file, null)
  }
}

/** Forget guards and presence (project closed). */
export function forgetSideFiles(): void {
  for (const entry of entries.values()) {
    entry.guard = null
    entry.present = false
  }
}

const serialize = (data: unknown) => JSON.stringify(data, null, 2) + '\n'

const stamp = () => new Date().toISOString().replace(/[^0-9A-Za-z-]/g, '-')

/** `comments.json` -> `comments.damaged-<stamp>.json`. */
export function asideName(name: string, kind: 'damaged' | 'newer'): string {
  return `${name.replace(/\.json$/, '')}.${kind}-${stamp()}.json`
}

/**
 * The side files to write with a save of `folder`, in the batch before the manuscript. A guarded
 * file is left out until the user changed it; then its original is copied aside first (a failed copy
 * throws: the save fails and nothing is written). A missing file is created only when not empty.
 * Call under the write lock; call `sideFilesSaved` after the batch succeeded.
 */
export async function sideFilesForSave(folder: string): Promise<{ files: BatchFile[]; written: string[] }> {
  const files: BatchFile[] = []
  const written: string[] = []
  for (const entry of entries.values()) {
    const { file, guard } = entry
    if (guard && file.getVersion() === guard.loadedVersion) continue
    const { data, empty } = file.serialize()
    if (!entry.present && empty) continue
    if (guard) await keepGuarded(folder, file.name, guard)
    files.push({ path: joinPath(folder, file.name), contents: serialize(data), label: file.name })
    written.push(file.name)
  }
  return { files, written }
}

/** Save As into a new folder: every side file that is not empty (nothing is on disk there yet). */
export function sideFilesForNewProject(folder: string): { files: BatchFile[]; written: string[] } {
  const files: BatchFile[] = []
  const written: string[] = []
  for (const { file } of entries.values()) {
    const { data, empty } = file.serialize()
    if (empty) continue
    files.push({ path: joinPath(folder, file.name), contents: serialize(data), label: file.name })
    written.push(file.name)
  }
  return { files, written }
}

/** The batch holding these side files was written. */
export function sideFilesSaved(names: readonly string[]): void {
  for (const name of names) {
    const entry = entries.get(name)
    if (!entry) continue
    entry.present = true
    entry.guard = null
  }
}

/** True while any side file is guarded (its warning stays up). */
export function hasGuardedSideFile(): boolean {
  return [...entries.values()].some((e) => e.guard !== null)
}

async function keepGuarded(folder: string, name: string, guard: SideGuard): Promise<void> {
  let original = guard.original
  if (original === null) {
    try {
      original = await readTextFile(joinPath(folder, name), name)
    } catch (e) {
      if (e instanceof ProjectError && e.code === 'missing-file') return
      throw e
    }
  }
  try {
    await writeFileAtomic(joinPath(folder, asideName(name, guard.kind)), original, `${name} copy`)
  } catch (e) {
    throw new ProjectError(
      'io',
      `Novel could not keep a copy of the existing ${name} before replacing it, so nothing was saved. Saving again will retry.`,
      { cause: e },
    )
  }
  guard.original = original
}

/** Side-file contents for a crash-recovery snapshot: every non-empty file, or one on disk. */
export function sideFilesForSnapshot(): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const entry of entries.values()) {
    const { data, empty } = entry.file.serialize()
    if (!empty || entry.present) out[entry.file.name] = data
  }
  return out
}

/** Comparable form of the loaded side files (crash recovery: is a snapshot identical to the save?). */
export function sideFilesKey(snapshot?: Record<string, unknown>): string {
  const names = [...entries.keys()].sort()
  return JSON.stringify(
    names.map((n) => {
      if (snapshot) return n in snapshot ? snapshot[n] : null
      const entry = entries.get(n)!
      const { data, empty } = entry.file.serialize()
      return empty && !entry.present ? null : data
    }),
  )
}

/**
 * Restore side files from a recovery snapshot (Restore): each file whose content differs from what is
 * loaded is loaded from the snapshot. A snapshot without side files (older Novel) changes nothing.
 * Returns true when something changed.
 */
export function restoreSideFiles(snapshot: Record<string, unknown> | undefined): boolean {
  if (!snapshot) return false
  let changed = false
  for (const entry of entries.values()) {
    if (!(entry.file.name in snapshot)) continue
    const data = snapshot[entry.file.name]
    if (JSON.stringify(entry.file.serialize().data) === JSON.stringify(data)) continue
    safeLoad(entry.file, data && typeof data === 'object' ? data : null)
    // Restored content is a change of the file (a guarded one may now be replaced).
    if (entry.guard) entry.guard.loadedVersion = Number.NaN
    changed = true
  }
  return changed
}

/**
 * Closing a saved project: write each side file's `closeData()` (comments: orphans pruned). Best
 * effort, never throws; a guarded file is left alone. Call under the write lock.
 */
export async function writeSideFilesOnClose(folder: string): Promise<void> {
  for (const entry of entries.values()) {
    if (entry.guard || !entry.file.closeData) continue
    let data: unknown | null
    try {
      data = entry.file.closeData()
    } catch (e) {
      console.warn(`Preparing ${entry.file.name} for close failed:`, e)
      continue
    }
    if (data === null || !entry.present) continue
    try {
      await writeFileAtomic(joinPath(folder, entry.file.name), serialize(data), entry.file.name)
    } catch (e) {
      console.warn(`Writing ${entry.file.name} on close failed:`, e)
    }
  }
}

/** Test-only. */
export function __resetSideFilesForTests(): void {
  entries.clear()
}
