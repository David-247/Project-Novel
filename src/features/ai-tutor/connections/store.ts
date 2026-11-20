import type { SliceCreator } from '@/shared/store/types'
import * as ipc from './ipc'
import type { Connection } from './types'

/**
 * The tutor's connections (Phase 5): what ai-connections.json holds (never a secret) and which
 * connection the tutor uses. The active id is a per-user convenience kept in localStorage.
 */
export interface TutorConnectionsSlice {
  tutorConnections: {
    list: Connection[]
    /** The connection the tutor uses; null when there is none. */
    activeId: string | null
    /** False until `load` has finished once. */
    loaded: boolean
    actions: {
      /** Read the saved connections and the remembered active one. */
      load: () => Promise<void>
      /** Replace all connections (Rust validates; a rejection leaves the store as it was). */
      save: (list: Connection[]) => Promise<void>
      /** Use this connection (ignored when it is not in the list); null clears. */
      setActive: (id: string | null) => void
    }
  }
}

export const ACTIVE_CONNECTION_KEY = 'novel.tutor.activeConnection'

function readActive(): string | null {
  try {
    return localStorage.getItem(ACTIVE_CONNECTION_KEY)
  } catch {
    return null
  }
}

function writeActive(id: string | null): void {
  try {
    if (id === null) localStorage.removeItem(ACTIVE_CONNECTION_KEY)
    else localStorage.setItem(ACTIVE_CONNECTION_KEY, id)
  } catch {
    // Storage unavailable: the choice is not remembered, nothing else breaks.
  }
}

/** The remembered id if it is still listed, else the first connection, else none. */
function pickActive(list: Connection[], wanted: string | null): string | null {
  return list.find((c) => c.id === wanted)?.id ?? list[0]?.id ?? null
}

export const createTutorConnectionsSlice: SliceCreator<TutorConnectionsSlice> = (set, get) => {
  const patch = (p: Partial<Omit<TutorConnectionsSlice['tutorConnections'], 'actions'>>) =>
    set((s) => ({ tutorConnections: { ...s.tutorConnections, ...p } }))
  return {
    tutorConnections: {
      list: [],
      activeId: null,
      loaded: false,
      actions: {
        load: async () => {
          const list = await ipc.getConnections()
          patch({ list, activeId: pickActive(list, readActive()), loaded: true })
        },
        save: async (list) => {
          await ipc.saveConnections(list)
          // Keep what Rust stored (it trims and drops a hosted provider's baseUrl).
          const saved = await ipc.getConnections()
          const activeId = pickActive(saved, get().tutorConnections.activeId)
          writeActive(activeId)
          patch({ list: saved, activeId, loaded: true })
        },
        setActive: (id) => {
          const next = id !== null && get().tutorConnections.list.some((c) => c.id === id) ? id : null
          writeActive(next)
          patch({ activeId: next })
        },
      },
    },
  }
}
