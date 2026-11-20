// The settings page's Rust commands besides connections and secrets (src-tauri/src/ai/oauth.rs). The
// browser is opened by Rust only: the webview has no open-URL capability, and these name a provider,
// never a URL.
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { ProviderId } from '../connections/types'

/** What `ai-oauth-result` carries. Never a key or a code. */
export interface OAuthResult {
  ok: boolean
  connectionId?: string
  error?: string
}

export const OAUTH_RESULT_EVENT = 'ai-oauth-result'

/**
 * Open the provider's sign-in page in the browser; the outcome comes as an `ai-oauth-result` event.
 * `connectionId`: sign that saved connection in again (a renewable sign-in: ChatGPT).
 */
export function startOAuth(provider: ProviderId, connectionId?: string, newAccount?: boolean): Promise<void> {
  return invoke<void>('ai_oauth_start', connectionId ? { provider, connectionId } : newAccount ? { provider, newAccount: true } : { provider })
}

/**
 * A renewable sign-in (ChatGPT): the email ("" when unknown) of the account Continue with ChatGPT would
 * sign in with again, or null when it would register a new one.
 */
export function reusableAccount(provider: ProviderId): Promise<string | null> {
  return invoke<string | null>('ai_oauth_reusable', { provider })
}

/** Open the provider's usage settings page ("Manage Usage"; Rust's allowlisted address for that provider). */
export function openUsagePage(provider: ProviderId): Promise<void> {
  return invoke<void>('ai_open_usage_page', { provider })
}

/** Stop waiting for the browser (the pending sign-in reports `ok: false`). */
export function cancelOAuth(): Promise<void> {
  return invoke<void>('ai_oauth_cancel')
}

/** Open the provider's "create an API key" page (Rust's allowlisted address for that provider). */
export function openKeyPage(provider: ProviderId): Promise<void> {
  return invoke<void>('ai_open_key_page', { provider })
}

/** Listen for sign-in outcomes; returns unlisten. */
export async function onOAuthResult(cb: (r: OAuthResult) => void): Promise<() => void> {
  return listen<OAuthResult>(OAUTH_RESULT_EVENT, (e) => cb(e.payload))
}
