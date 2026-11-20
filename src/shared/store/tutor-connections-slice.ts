import type { SliceCreator } from './types'

/**
 * The AI tutor's saved connections (Phase 5), as the tutor's connection list needs them. Plain state
 * and setters only: src/features/ai-tutor reads and writes ai-connections.json (through Rust) and
 * calls these. A connection never holds a secret; keys live in the OS keychain.
 */
export interface TutorConnection {
  id: string
  provider: string
  label: string
  auth: 'api_key' | 'oauth' | 'none'
  baseUrl?: string
  defaultModel?: string
  toolSupport?: Record<string, boolean>
  insecureHttpAccepted?: boolean
}

export interface TutorConnectionsSlice {
  tutorConnections: {
    list: TutorConnection[]
    /** The connection the tutor uses (persisted as the `tutorActiveConnection` preference); null = none. */
    activeId: string | null
    /** False until the connections have been read once. */
    loaded: boolean
  }
  tutorConnectionsActions: {
    /** Replace the list, the active id and mark the slice loaded. */
    setConnections: (list: TutorConnection[], activeId: string | null) => void
    setActiveId: (id: string | null) => void
  }
}

export const createTutorConnectionsSlice: SliceCreator<TutorConnectionsSlice> = (set) => ({
  tutorConnections: { list: [], activeId: null, loaded: false },
  tutorConnectionsActions: {
    setConnections: (list, activeId) => set(() => ({ tutorConnections: { list, activeId, loaded: true } })),
    setActiveId: (activeId) => set((s) => ({ tutorConnections: { ...s.tutorConnections, activeId } })),
  },
})
