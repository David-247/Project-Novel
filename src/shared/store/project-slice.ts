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
  }
}

export const initialProjectState: ProjectState = {
  path: null,
  title: null,
  saveStatus: 'idle',
  lastSavedAt: null,
  saveError: null,
  recent: [],
}

export const createProjectSlice: SliceCreator<ProjectSlice> = (set) => {
  const patch = (p: Partial<ProjectState>) => set((s) => ({ project: { ...s.project, ...p } }))
  return {
    project: initialProjectState,
    projectActions: {
      projectOpened: ({ path, title }) =>
        patch({ path, title, saveStatus: 'idle', lastSavedAt: null, saveError: null }),
      projectClosed: () =>
        patch({ path: null, title: null, saveStatus: 'idle', lastSavedAt: null, saveError: null }),
      saveStarted: () => patch({ saveStatus: 'saving', saveError: null }),
      saveSucceeded: (at) => patch({ saveStatus: 'saved', lastSavedAt: at, saveError: null }),
      saveFailed: (message) => patch({ saveStatus: 'error', saveError: message }),
      setRecent: (recent) => patch({ recent }),
    },
  }
}
