// The webview's side of the secret and connection commands (src-tauri/src/ai). There is deliberately
// no way to read a secret back: only Rust reads the keychain, when it proxies a request.
import { invoke } from '@tauri-apps/api/core'
import type { Connection } from './types'

/** Store (or replace) a connection's credential in the OS keychain. */
export function setSecret(connectionId: string, secret: string): Promise<void> {
  return invoke<void>('ai_secret_set', { connectionId, secret })
}

export function deleteSecret(connectionId: string): Promise<void> {
  return invoke<void>('ai_secret_delete', { connectionId })
}

/** Whether the keychain holds a credential for the connection. */
export function hasSecret(connectionId: string): Promise<boolean> {
  return invoke<boolean>('ai_secret_has', { connectionId })
}

export function getConnections(): Promise<Connection[]> {
  return invoke<Connection[]>('ai_connections_get')
}

/**
 * Add a connection, or replace the saved one with its id; Rust leaves every other connection as it is on
 * disk, validates this one (a bad `baseUrl` rejects it) and drops its key if it was re-pointed. There is
 * deliberately no whole-list save: it could drop a connection added meanwhile (a sign-in).
 */
export function upsertConnection(connection: Connection): Promise<void> {
  return invoke<void>('ai_connection_upsert', { connection })
}

/**
 * Remove one connection and its key; the others stay as they are on disk. A plan sign-in (ChatGPT) is
 * signed out at the provider first: the result says whether the provider confirmed it (null: not a
 * plan sign-in).
 */
export async function removeConnection(connectionId: string): Promise<boolean | null> {
  return (await invoke<boolean | null>('ai_connection_remove', { connectionId })) ?? null
}
