import type { SliceCreator } from './types'

// Unsaved-changes state is NOT kept here: `editor.dirty` (editor slice) is the
// single source of truth.

/** 'idle' = nothing saved yet this session; 'error' = last save failed. */
export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error'

export interface RecentProject {
  /** Absolute path of the project folder. */
  path: string
  /** Display name (project title). */
  name: string
  /** ISO timestamp of the last open. */
  openedAt: string
  /** True if the folder or its project.json could not be found at last check. */
  missing?: boolean
}

/**
 * A crash-recovery question for the user: restore the backup found in the
 * open project, or reopen the last project because it has a backup.
 */
export type RecoveryPrompt =
  | { kind: 'restore'; savedAt: string }
  | { kind: 'reopen'; path: string; name: string }

export interface ProjectState {
  /** Absolute path of the open project folder, or null when none is open. */
  path: string | null
  /** Title of the open project. */
  title: string | null
  saveStatus: SaveStatus
  /** Epoch ms of the last successful save. */
  lastSavedAt: number | null
  /** User-facing message for the last failed save, if any. */
  saveError: string | null
  /** Most-recent-first. */
  recent: RecentProject[]
  /** Epoch ms of the last successful crash-recovery snapshot (autosave). */
  lastBackupAt: number | null
  /** Non-blocking warning while autosave snapshots fail (retrying). */
  backupWarning: string | null
  /** Pending crash-recovery question, if any. */
  recoveryPrompt: RecoveryPrompt | null
  /**
   * `savedAt` of a backup found on open that is still unanswered (Restore / Discard), even while
   * its prompt is closed ("Decide later"); null when there is none. Drives the status-bar
   * "Backup available" control that re-opens the prompt.
   */
  pendingRecoveryAt: string | null
  /** One-off, non-modal status note about recovery data (e.g. set-aside `unrestored-*` files). */
  recoveryNotice: string | null
  /** True while a project is being opened (reading and loading a possibly large manuscript). */
  opening: boolean
}

export interface ProjectSlice {
  project: ProjectState
  /** Named actions: the only way to change `project` state. */
  projectActions: {
    projectOpened: (p: { path: string; title: string }) => void
    projectClosed: () => void
    saveStarted: () => void
    saveSucceeded: (at: number) => void
    saveFailed: (message: string) => void
    setRecent: (recent: RecentProject[]) => void
    backupSucceeded: (at: number) => void
    backupFailed: (warning: string) => void
    /** Recovery data was deleted (clean save, discard, quit). */
    backupCleared: () => void
    showRecoveryPrompt: (prompt: RecoveryPrompt) => void
    dismissRecoveryPrompt: () => void
    /** A found backup became unanswered (`savedAt`) or was answered / set aside (null). */
    setPendingRecovery: (savedAt: string | null) => void
    setRecoveryNotice: (notice: string | null) => void
    /** Opening a project started / finished (success or failure). */
    openStarted: () => void
    openFinished: () => void
  }
}

export const initialProjectState: ProjectState = {
  path: null,
  title: null,
  saveStatus: 'idle',
  lastSavedAt: null,
  saveError: null,
  recent: [],
  lastBackupAt: null,
  backupWarning: null,
  recoveryPrompt: null,
  pendingRecoveryAt: null,
  recoveryNotice: null,
  opening: false,
}

export const createProjectSlice: SliceCreator<ProjectSlice> = (set) => {
  const patch = (p: Partial<ProjectState>) => set((s) => ({ project: { ...s.project, ...p } }))
  return {
    project: initialProjectState,
    projectActions: {
      projectOpened: ({ path, title }) =>
        patch({
          path,
          title,
          saveStatus: 'idle',
          lastSavedAt: null,
          saveError: null,
          lastBackupAt: null,
          backupWarning: null,
          recoveryPrompt: null,
          pendingRecoveryAt: null,
          recoveryNotice: null,
        }),
      projectClosed: () =>
        patch({
          path: null,
          title: null,
          saveStatus: 'idle',
          lastSavedAt: null,
          saveError: null,
          lastBackupAt: null,
          backupWarning: null,
          recoveryPrompt: null,
          pendingRecoveryAt: null,
          recoveryNotice: null,
          opening: false,
        }),
      saveStarted: () => patch({ saveStatus: 'saving', saveError: null }),
      saveSucceeded: (at) => patch({ saveStatus: 'saved', lastSavedAt: at, saveError: null }),
      saveFailed: (message) => patch({ saveStatus: 'error', saveError: message }),
      setRecent: (recent) => patch({ recent }),
      backupSucceeded: (at) => patch({ lastBackupAt: at, backupWarning: null }),
      backupFailed: (warning) => patch({ backupWarning: warning }),
      backupCleared: () => patch({ lastBackupAt: null, backupWarning: null }),
      showRecoveryPrompt: (recoveryPrompt) => patch({ recoveryPrompt }),
      dismissRecoveryPrompt: () => patch({ recoveryPrompt: null }),
      setPendingRecovery: (pendingRecoveryAt) => patch({ pendingRecoveryAt }),
      setRecoveryNotice: (recoveryNotice) => patch({ recoveryNotice }),
      openStarted: () => patch({ opening: true }),
      openFinished: () => patch({ opening: false }),
    },
  }
}
