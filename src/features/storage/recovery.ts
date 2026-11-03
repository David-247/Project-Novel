import type { DocJSON } from '@/shared/document'
import { isDocJSON, joinPath, ProjectError, serializeManuscript, type ProjectMeta } from './format'
import { ensureDir, listDir, readTextFile, removeFile, writeFileAtomic } from './ipc'

/**
 * Crash-recovery snapshot (docs/project-format.md, "Crash recovery").
 * Autosave writes it to `<project>/.recovery/manuscript.json`; it never
 * overwrites the user's manuscript.json.
 */
export const RECOVERY_DIR = '.recovery'
export const RECOVERY_FILE = 'manuscript.json'
export const RECOVERY_FORMAT = 'novel-recovery'
export const RECOVERY_VERSION = 1
/** Label used in error messages. */
const LABEL = 'The backup copy'

export interface RecoverySnapshot {
  format: typeof RECOVERY_FORMAT
  version: number
  /** project.json `id` of the project the snapshot belongs to. */
  projectId: string
  /** ISO 8601 time the snapshot was taken. */
  savedAt: string
  /** project.json `updatedAt` (last real save) when the snapshot was taken. */
  baseUpdatedAt: string
  /** Editor document version at snapshot time (diagnostic only). */
  docVersion: number
  doc: DocJSON
}

export const recoveryDirPath = (folder: string) => joinPath(folder, RECOVERY_DIR)
export const recoveryFilePath = (folder: string) => joinPath(recoveryDirPath(folder), RECOVERY_FILE)

/** Compact JSON (like manuscript.json). */
export function serializeRecovery(s: RecoverySnapshot): string {
  return JSON.stringify(s)
}

/** Parse a recovery file; null if it is damaged or from a newer Novel (then it is ignored, not deleted). */
export function parseRecovery(text: string): RecoverySnapshot | null {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof data !== 'object' || data === null) return null
  const d = data as Record<string, unknown>
  if (d.format !== RECOVERY_FORMAT || typeof d.version !== 'number' || d.version > RECOVERY_VERSION) return null
  if (typeof d.savedAt !== 'string' || Number.isNaN(Date.parse(d.savedAt))) return null
  if (!isDocJSON(d.doc)) return null
  return {
    format: RECOVERY_FORMAT,
    version: d.version,
    projectId: typeof d.projectId === 'string' ? d.projectId : '',
    savedAt: d.savedAt,
    baseUpdatedAt: typeof d.baseUpdatedAt === 'string' ? d.baseUpdatedAt : '',
    docVersion: typeof d.docVersion === 'number' ? d.docVersion : 0,
    doc: d.doc,
  }
}

/** Write the snapshot atomically, creating `.recovery/` if needed. Throws ProjectError. */
export async function writeRecoveryFile(folder: string, text: string): Promise<void> {
  await ensureDir(recoveryDirPath(folder), LABEL)
  await writeFileAtomic(recoveryFilePath(folder), text, LABEL)
}

/** The raw recovery file, or null if there is none. Throws ProjectError for other failures. */
export async function readRecoveryFile(folder: string): Promise<string | null> {
  try {
    return await readTextFile(recoveryFilePath(folder), LABEL)
  } catch (e) {
    if (e instanceof ProjectError && e.code === 'missing-file') return null
    throw e
  }
}

/** File name for a snapshot set aside unanswered: `unrestored-<savedAt>.json` (no `:` for Windows). */
export function unrestoredFileName(savedAt: string): string {
  return `unrestored-${savedAt.replace(/[^0-9A-Za-z-]/g, '-')}.json`
}

/** Keep `text` (a snapshot nobody answered) as `.recovery/unrestored-<savedAt>.json`. Throws ProjectError. */
export async function writeUnrestoredFile(folder: string, savedAt: string, text: string): Promise<void> {
  await ensureDir(recoveryDirPath(folder), LABEL)
  await writeFileAtomic(joinPath(recoveryDirPath(folder), unrestoredFileName(savedAt)), text, LABEL)
}

/** True for a file name written by writeUnrestoredFile. */
export function isUnrestoredFileName(name: string): boolean {
  return /^unrestored-.*\.json$/.test(name)
}

/** Names of the set-aside `unrestored-*.json` snapshots in `.recovery/` (sorted). Throws ProjectError. */
export async function listUnrestoredFiles(folder: string): Promise<string[]> {
  return (await listDir(recoveryDirPath(folder), LABEL)).filter(isUnrestoredFileName).sort()
}

/**
 * What to do with a snapshot found when a project is opened:
 * - 'offer': it was taken on top of the current save (`baseUpdatedAt` equals
 *   project.json `updatedAt`); ask Restore / Discard.
 * - 'identical': same content as manuscript.json; safe to delete.
 * - 'unrelated': another project's, or taken on top of a different save; do not
 *   offer, and do not delete (move it aside).
 * Timestamps are compared for equality only, so a clock change can never make
 * Novel drop a snapshot. Only a snapshot without `baseUpdatedAt` falls back to
 * comparing `savedAt` with `updatedAt`.
 */
export type RecoveryVerdict = 'offer' | 'identical' | 'unrelated'

export function judgeRecovery(s: RecoverySnapshot, meta: ProjectMeta, manuscriptText?: string): RecoveryVerdict {
  if (s.projectId && s.projectId !== meta.id) return 'unrelated'
  if (manuscriptText !== undefined && serializeManuscript(s.doc) === manuscriptText) return 'identical'
  if (s.baseUpdatedAt) return s.baseUpdatedAt === meta.updatedAt ? 'offer' : 'unrelated'
  return Date.parse(s.savedAt) > Date.parse(meta.updatedAt) ? 'offer' : 'unrelated'
}

/** Delete the recovery file (idempotent). Throws ProjectError. */
export async function deleteRecoveryFile(folder: string): Promise<void> {
  await removeFile(recoveryFilePath(folder), LABEL)
}

// ---- Suppression after "Don't Save" ----------------------------------------
// When the user discards their changes, autosave must not write a fresh
// snapshot of the very content they discarded (e.g. while a folder picker for
// another project is open). Snapshots resume as soon as the document changes.

let discardedVersion: number | null = null

export function suppressSnapshotsAt(version: number | null): void {
  discardedVersion = version
}

export function snapshotsSuppressedAt(version: number): boolean {
  return discardedVersion === version
}
