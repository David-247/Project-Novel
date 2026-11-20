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

/** Read what Rust stored and keep the active one (else the first). */
async function reload(): Promise<void> {
  const saved = await ipc.getConnections()
  const activeId = pickActive(saved, state().tutorConnections.activeId)
  state().tutorConnectionsActions.setConnections(saved, activeId)
  rememberActive(activeId)
}

/**
 * Save one connection (add, or replace the one with its id). Only that entry changes: Rust merges it
 * into the file as it is now, so a connection added meanwhile (a sign-in) is never dropped (T10 I1).
 * Settings uses this and `removeTutorConnection`, never a whole-list save.
 */
export async function upsertTutorConnection(c: Connection): Promise<void> {
  await ipc.upsertConnection(c)
  await reload()
}

/**
 * Remove one connection (Rust deletes its key, and signs a plan sign-in out at the provider); the others
 * stay as they are on disk. Returns whether the provider confirmed the sign-out (null: nothing to sign out).
 */
export async function removeTutorConnection(id: string): Promise<boolean | null> {
  const signedOut = await ipc.removeConnection(id)
  await reload()
  return signedOut
}

/** Use this connection (ignored, as none, when it is not in the list); null clears. */
export function setActiveTutorConnection(id: string | null): void {
  const next = id !== null && state().tutorConnections.list.some((c) => c.id === id) ? id : null
  state().tutorConnectionsActions.setActiveId(next)
  rememberActive(next)
}
