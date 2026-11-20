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

/** Replace the saved connections. Rust validates them (a bad `baseUrl` rejects the whole save). */
export function saveConnections(connections: Connection[]): Promise<void> {
  return invoke<void>('ai_connections_save', { connections })
}
