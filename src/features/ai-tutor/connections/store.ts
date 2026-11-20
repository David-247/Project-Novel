import { useStore } from '@/shared/store'
import * as ipc from './ipc'
import type { Connection } from './types'

/**
 * The tutor's connections: the IO half. The state is the shared store's `tutorConnections` slice;
 * these functions read and write ai-connections.json through Rust (`ipc`) and call its setters. The
 * active connection id is the `tutorActiveConnection` preference (preferences.json).
 */

const state = () => useStore.getState()

/** The wanted id if it is still listed, else the first connection, else none. */
function pickActive(list: Connection[], wanted: string | null): string | null {
  return list.find((c) => c.id === wanted)?.id ?? list[0]?.id ?? null
}

function rememberActive(id: string | null): void {
  if (state().preferences.tutorActiveConnection !== id) state().preferencesActions.set('tutorActiveConnection', id)
}

/** The saved connections as the store holds them. */
export const getTutorConnections = (): Connection[] => state().tutorConnections.list as Connection[]

/** Read the saved connections; the active one is the remembered preference (call after preferences load). */
export async function loadTutorConnections(): Promise<void> {
  const list = await ipc.getConnections()
  state().tutorConnectionsActions.setConnections(list, pickActive(list, state().preferences.tutorActiveConnection))
}

/** Replace all connections (Rust validates; a rejection leaves the store as it was). */
export async function saveTutorConnections(list: Connection[]): Promise<void> {
  await ipc.saveConnections(list)
  // Keep what Rust stored (it trims, and drops a hosted provider's baseUrl).
  const saved = await ipc.getConnections()
  const activeId = pickActive(saved, state().tutorConnections.activeId)
  state().tutorConnectionsActions.setConnections(saved, activeId)
  rememberActive(activeId)
}

/** Use this connection (ignored, as none, when it is not in the list); null clears. */
export function setActiveTutorConnection(id: string | null): void {
  const next = id !== null && state().tutorConnections.list.some((c) => c.id === id) ? id : null
  state().tutorConnectionsActions.setActiveId(next)
  rememberActive(next)
}
