import { getDocumentProvider, onDocumentProviderChange, type DocumentProvider } from '@/shared/document'
import { useStore } from '@/shared/store'
import { ProjectError } from './format'
import {
  getCurrentProjectMeta,
  getCurrentProjectPath,
  onProjectOpened,
  preserveUnansweredRecoveryUnlocked,
} from './project'
import {
  RECOVERY_FORMAT,
  RECOVERY_VERSION,
  serializeRecovery,
  snapshotsSuppressedAt,
  writeRecoveryFile,
} from './recovery'
import { withWriteLock } from './write-lock'

/**
 * Autosave = crash-recovery snapshots.
 *
 * While the document has unsaved changes, at most every 30 s its content is
 * written to `<project>/.recovery/manuscript.json` (never over manuscript.json,
 * so an explicit Save keeps its meaning). Timing is a trailing throttle: the
 * first change after a snapshot arms ONE 30 s timer; later keystrokes do not
 * re-arm it, so continuous typing still gets a snapshot every 30 s and a crash
 * loses at most 30 s of work. The document is serialized only when the timer
 * fires, never per keystroke. Snapshots go through the project write lock, so
 * they never overlap a manual save.
 *
 * Failures (disk full, read-only folder, ...) show a non-blocking warning in the
 * status bar and are retried after 5 s, 15 s, then every 30 s.
 */
export const AUTOSAVE_INTERVAL_MS = 30_000
export const AUTOSAVE_RETRY_DELAYS_MS = [5_000, 15_000, 30_000] as const

let running = false
let timer: ReturnType<typeof setTimeout> | null = null
let inFlight: Promise<void> | null = null
/** Doc version captured by the last successful snapshot of the current project. */
let lastSnapshotVersion: number | null = null
let failures = 0
let disposers: (() => void)[] = []
let unwatchDoc: (() => void) | null = null

const actions = () => useStore.getState().projectActions

function clearTimer(): void {
  if (timer !== null) clearTimeout(timer)
  timer = null
}

/** Arm the timer unless it is already armed (trailing throttle, not a debounce). */
function arm(delay: number = AUTOSAVE_INTERVAL_MS): void {
  if (!running || timer !== null) return
  timer = setTimeout(() => {
    timer = null
    void autosaveNow()
  }, delay)
}

function retryDelay(): number {
  return AUTOSAVE_RETRY_DELAYS_MS[Math.min(failures, AUTOSAVE_RETRY_DELAYS_MS.length) - 1]
}

/** Short status-bar warning for a failed snapshot. */
export function backupWarningText(e: unknown, retryMs: number): string {
  const secs = Math.round(retryMs / 1000)
  const reason =
    e instanceof ProjectError && e.code === 'disk-full'
      ? 'the disk is full'
      : e instanceof ProjectError && e.code === 'read-only'
        ? 'the project folder is read-only'
        : e instanceof ProjectError && e.code === 'write-denied'
          ? 'could not write (folder read-only or file in use)'
          : 'the project folder could not be written'
  return `Autosave failed: ${reason}. Retrying in ${secs} s.`
}

/** What a snapshot attempt did (for tests and diagnostics). */
export type AutosaveResult = 'written' | 'skipped' | 'failed'

/**
 * Take a snapshot now if there is something to protect: a project is open,
 * the document is dirty and changed since the last snapshot. Waits for (never
 * overlaps) a manual save. Never throws.
 */
export function autosaveNow(): Promise<AutosaveResult> {
  const run = inFlight ? inFlight.then(snapshot) : snapshot()
  const settled = run.then(() => undefined)
  inFlight = settled
  void settled.finally(() => {
    if (inFlight === settled) inFlight = null
  })
  return run
}

async function snapshot(): Promise<AutosaveResult> {
  const folder = getCurrentProjectPath()
  if (!folder || !getCurrentProjectMeta() || !getDocumentProvider()) return 'skipped'
  try {
    const written = await withWriteLock(async () => {
      // Re-read everything under the lock: a save may just have finished or a project may have changed.
      const p = getDocumentProvider()
      const meta = getCurrentProjectMeta()
      if (!p || !meta || getCurrentProjectPath() !== folder) return false
      const version = p.getDocVersion()
      if (!p.isDirty() || version === lastSnapshotVersion || snapshotsSuppressedAt(version)) return false
      const text = serializeRecovery({
        format: RECOVERY_FORMAT,
        version: RECOVERY_VERSION,
        projectId: meta.id,
        savedAt: new Date().toISOString(),
        baseUpdatedAt: meta.updatedAt,
        docVersion: version,
        doc: p.getDocJSON(),
      })
      // A snapshot the user has not answered yet is moved aside, never overwritten.
      await preserveUnansweredRecoveryUnlocked(folder)
      await writeRecoveryFile(folder, text)
      lastSnapshotVersion = version
      return true
    })
    if (getCurrentProjectPath() !== folder) return written ? 'written' : 'skipped'
    failures = 0
    if (written) actions().backupSucceeded(Date.now())
    else if (useStore.getState().project.backupWarning) actions().backupCleared()
    rearmIfStillDirty()
    return written ? 'written' : 'skipped'
  } catch (e) {
    if (getCurrentProjectPath() !== folder) return 'failed'
    failures++
    const delay = retryDelay()
    actions().backupFailed(backupWarningText(e, delay))
    console.warn('Autosave snapshot failed:', e)
    clearTimer()
    arm(delay)
    return 'failed'
  }
}

/** Edits made while the snapshot was being written need their own snapshot. */
function rearmIfStillDirty(): void {
  const p = getDocumentProvider()
  if (!p || !p.isDirty()) return
  const version = p.getDocVersion()
  if (version !== lastSnapshotVersion && !snapshotsSuppressedAt(version)) arm()
}

/** Per keystroke: O(1), no serialization. Recovery for a never-saved document is out of scope. */
function onEdit(): void {
  if (getCurrentProjectPath()) arm()
}

function watchProvider(p: DocumentProvider | null): void {
  unwatchDoc?.()
  unwatchDoc = p ? p.onDocChange(onEdit) : null
}

/**
 * Start autosaving (idempotent). Returns a function that stops it. Called by
 * useStorageIntegration; nothing is written while no project is open.
 */
export function startAutosave(): () => void {
  if (running) return stopAutosave
  running = true
  watchProvider(getDocumentProvider())
  disposers = [
    onDocumentProviderChange(watchProvider),
    onProjectOpened(() => {
      clearTimer()
      lastSnapshotVersion = null
      failures = 0
    }),
  ]
  // Work restored from a backup (or edited before autosave started) is protected too.
  rearmIfStillDirty()
  return stopAutosave
}

/** Stop the timer and listeners. Resolves once an in-flight snapshot has settled. */
export async function stopAutosave(): Promise<void> {
  running = false
  clearTimer()
  disposers.forEach((d) => d())
  disposers = []
  watchProvider(null)
  await inFlight
}

/** Test-only. */
export async function __resetAutosaveForTests(): Promise<void> {
  await stopAutosave()
  inFlight = null
  lastSnapshotVersion = null
  failures = 0
}
