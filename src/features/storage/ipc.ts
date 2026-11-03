import { invoke } from '@tauri-apps/api/core'
import { ProjectError } from './format'

/** Command names (src-tauri/src/storage.rs). */
export const COMMANDS = {
  setProjectRoot: 'storage_set_project_root',
  writeFileAtomic: 'storage_write_file_atomic',
  readTextFile: 'storage_read_text_file',
  pathExists: 'storage_path_exists',
  readRecent: 'storage_read_recent',
  writeRecent: 'storage_write_recent',
  setRecentMenu: 'storage_set_recent_menu',
} as const

/** Events emitted by the native File menu. `OPEN_RECENT` carries the folder path. */
export const MENU_EVENTS = {
  NEW_PROJECT: 'menu://new-project',
  OPEN_PROJECT: 'menu://open-project',
  OPEN_RECENT: 'menu://open-recent',
  SAVE: 'menu://save',
} as const

/** Error shape returned by the Rust storage commands. */
interface RustStorageError {
  kind: 'not_found' | 'invalid_path' | 'outside_project' | 'symlink' | 'io'
  message: string
}

function isRustError(e: unknown): e is RustStorageError {
  return typeof e === 'object' && e !== null && 'kind' in e && 'message' in e
}

/** Convert a rejected invoke into a ProjectError with a friendly message. */
function toProjectError(e: unknown, fileLabel: string): ProjectError {
  if (isRustError(e) && e.kind === 'not_found') {
    return new ProjectError('missing-file', `${fileLabel} could not be found.`, { cause: e })
  }
  if (isRustError(e) && e.kind === 'symlink') {
    return new ProjectError('io', `${fileLabel} is a symbolic link; Novel will not overwrite it.`, { cause: e })
  }
  if (isRustError(e) && e.kind === 'outside_project') {
    return new ProjectError('io', `${fileLabel} is outside the project folder, so Novel will not touch it.`, { cause: e })
  }
  const detail = isRustError(e) ? e.message : String(e)
  return new ProjectError('io', `${fileLabel} could not be accessed (${detail}).`, { cause: e })
}

/**
 * Confine the file commands to `folder` (the user-chosen project folder), or
 * clear with null. Reads and writes outside it are refused by Rust.
 */
export async function setProjectRoot(folder: string | null): Promise<void> {
  try {
    await invoke(COMMANDS.setProjectRoot, { path: folder })
  } catch (e) {
    throw toProjectError(e, folder ?? 'project folder')
  }
}

/** Atomically write a text file inside the project root: random temp file in the same folder, fsync, rename. */
export async function writeFileAtomic(path: string, contents: string, fileLabel = path): Promise<void> {
  try {
    await invoke(COMMANDS.writeFileAtomic, { path, contents })
  } catch (e) {
    throw toProjectError(e, fileLabel)
  }
}

export async function readTextFile(path: string, fileLabel = path): Promise<string> {
  try {
    return await invoke<string>(COMMANDS.readTextFile, { path })
  } catch (e) {
    throw toProjectError(e, fileLabel)
  }
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    return await invoke<boolean>(COMMANDS.pathExists, { path })
  } catch {
    return false
  }
}

export function readRecentRaw(): Promise<string | null> {
  return invoke<string | null>(COMMANDS.readRecent)
}

export function writeRecentRaw(contents: string): Promise<void> {
  return invoke(COMMANDS.writeRecent, { contents })
}

export interface RecentMenuEntry {
  path: string
  label: string
  missing: boolean
}

export function setRecentMenu(entries: RecentMenuEntry[]): Promise<void> {
  return invoke(COMMANDS.setRecentMenu, { entries })
}
