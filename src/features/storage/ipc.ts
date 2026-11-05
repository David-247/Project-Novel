import { invoke } from '@tauri-apps/api/core'
import { ProjectError } from './format'

/** Command names (src-tauri/src/storage.rs). */
export const COMMANDS = {
  pickProjectFolder: 'storage_pick_project_folder',
  openRecentRoot: 'storage_open_recent_root',
  restoreProjectRoot: 'storage_restore_project_root',
  clearProjectRoot: 'storage_clear_project_root',
  writeFileAtomic: 'storage_write_file_atomic',
  readTextFile: 'storage_read_text_file',
  pathExists: 'storage_path_exists',
  ensureDir: 'storage_ensure_dir',
  removeFile: 'storage_remove_file',
  readRecent: 'storage_read_recent',
  rememberRecent: 'storage_remember_recent',
  exitApp: 'storage_exit_app',
  probeRecentRecovery: 'storage_probe_recent_recovery',
  listDir: 'storage_list_dir',
  listSubdirs: 'storage_list_subdirs',
} as const

/**
 * Storage events (still honoured). The native menu itself sends `menu://command` with a command id
 * (menu slice); Rust sends QUIT for an exit request it held. `OPEN_RECENT` carries the folder path.
 */
export const MENU_EVENTS = {
  NEW_PROJECT: 'menu://new-project',
  OPEN_PROJECT: 'menu://open-project',
  OPEN_RECENT: 'menu://open-recent',
  SAVE: 'menu://save',
  /**
   * Quit requested (Quit menu item, Cmd/Ctrl+Q, or an exit request Rust held). Not sent for macOS
   * Dock > Quit, logoff or Windows shutdown, which bypass the quit flow (crash recovery: <= 30 s lost).
   */
  QUIT: 'menu://quit',
} as const

/** Error shape returned by the Rust storage commands. */
interface RustStorageError {
  kind:
    | 'not_found'
    | 'invalid_path'
    | 'outside_project'
    | 'not_recent'
    | 'symlink'
    | 'disk_full'
    | 'read_only'
    | 'permission_denied'
    | 'io'
  message: string
}

function isRustError(e: unknown): e is RustStorageError {
  return typeof e === 'object' && e !== null && 'kind' in e && 'message' in e
}

/** Convert a rejected invoke into a ProjectError with a friendly message. */
export function toProjectError(e: unknown, fileLabel: string): ProjectError {
  if (isRustError(e) && e.kind === 'disk_full') {
    return new ProjectError(
      'disk-full',
      `The disk is full, so ${fileLabel} could not be saved. Free up some space and try again.`,
      { cause: e },
    )
  }
  if (isRustError(e) && e.kind === 'read_only') {
    return new ProjectError(
      'read-only',
      `Novel could not write ${fileLabel} because the project folder is read-only.`,
      { cause: e },
    )
  }
  if (isRustError(e) && e.kind === 'permission_denied') {
    // Windows reports a file held open by another program (antivirus, sync tools) the same way.
    return new ProjectError(
      'write-denied',
      `Novel could not write ${fileLabel}. The project folder may be read-only, or the file is in use by another program.`,
      { cause: e },
    )
  }
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
 * Native folder picker shown by Rust. The chosen folder becomes the project
 * root that file commands are confined to. Resolves null if cancelled.
 */
export async function pickProjectFolder(title: string): Promise<string | null> {
  try {
    return await invoke<string | null>(COMMANDS.pickProjectFolder, { title })
  } catch (e) {
    throw toProjectError(e, 'The chosen folder')
  }
}

/** Grant a folder from the (Rust-written) recent list as the project root. */
export async function openRecentRoot(path: string): Promise<void> {
  try {
    await invoke(COMMANDS.openRecentRoot, { path })
  } catch (e) {
    if (isRustError(e) && e.kind === 'not_found') {
      throw new ProjectError('missing-folder', `The project folder could not be found:
${path}`, { cause: e })
    }
    throw toProjectError(e, path)
  }
}

/** Undo the last root grant (after a failed create/open). Never throws. */
export async function restoreProjectRoot(): Promise<void> {
  await invoke(COMMANDS.restoreProjectRoot).catch((e) => console.warn('Restoring the project folder failed:', e))
}

/** No project: file commands refuse everything. Never throws. */
export async function clearProjectRoot(): Promise<void> {
  await invoke(COMMANDS.clearProjectRoot).catch((e) => console.warn('Clearing the project folder failed:', e))
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

/** Create a subfolder of the project root if it does not exist yet. */
export async function ensureDir(path: string, fileLabel = path): Promise<void> {
  try {
    await invoke(COMMANDS.ensureDir, { path })
  } catch (e) {
    throw toProjectError(e, fileLabel)
  }
}

/** Delete a file inside the project root. Resolves false if it did not exist. */
export async function removeFile(path: string, fileLabel = path): Promise<boolean> {
  try {
    return await invoke<boolean>(COMMANDS.removeFile, { path })
  } catch (e) {
    throw toProjectError(e, fileLabel)
  }
}

/** Names of the files directly inside a folder of the project root (none if it does not exist). */
export async function listDir(path: string, fileLabel = path): Promise<string[]> {
  try {
    return await invoke<string[]>(COMMANDS.listDir, { path })
  } catch (e) {
    throw toProjectError(e, fileLabel)
  }
}

/** Names of the folders directly inside a folder of the project root (none if it does not exist). */
export async function listSubdirs(path: string, fileLabel = path): Promise<string[]> {
  try {
    return await invoke<string[]>(COMMANDS.listSubdirs, { path })
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

/** Add the ACTIVE project root to the recent list (Rust supplies the path). Returns the new file JSON. */
export function rememberRecentRaw(name: string, openedAt: string): Promise<string> {
  return invoke<string>(COMMANDS.rememberRecent, { name, openedAt })
}


/** project.json + `.recovery/manuscript.json` of a recent project (raw text; null = missing). */
export interface RecoveryProbe {
  project: string | null
  recovery: string | null
}

/** Read a recent project's crash-recovery data without opening it (Rust allows recent folders only). */
export function probeRecentRecovery(path: string): Promise<RecoveryProbe> {
  return invoke<RecoveryProbe>(COMMANDS.probeRecentRecovery, { path })
}

/** Exit the app (after the quit flow approved it). */
export function exitApp(): Promise<void> {
  return invoke(COMMANDS.exitApp)
}
