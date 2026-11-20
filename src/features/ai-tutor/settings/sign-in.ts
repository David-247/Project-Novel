import { create } from 'zustand'
import { useStore } from '@/shared/store'
import { loadTutorConnections, setActiveTutorConnection } from '../connections/store'
import type { ProviderId } from '../connections/types'
import { getAdapter } from '../providers/registry'
import { cancelOAuth, onOAuthResult, startOAuth, type OAuthResult } from './ipc'

/**
 * Sign in with OpenRouter or ChatGPT, as the settings page shows it. Rust does the whole flow
 * (src-tauri/src/ai/oauth.rs, chatgpt.rs) and reports with the `ai-oauth-result` event; the listener
 * lives as long as the app (the composition root, through registerTutorCommands), so a sign-in finished
 * after Settings was closed still adds its connection. One sign-in runs at a time (Rust replaces an
 * older one).
 */
export type SignInStatus = 'idle' | 'waiting' | 'done' | 'failed'

interface SignInState {
  status: SignInStatus
  /** What the page says about the last sign-in (never a key, a token or a code). */
  message: string
  /** The provider of the sign-in that is waiting or finished last. */
  provider: ProviderId | null
  /** The saved connection being signed in again, if this is a renewal. */
  renewing: string | null
}

export const useSignIn = create<SignInState>()(() => ({ status: 'idle', message: '', provider: null, renewing: null }))

const set = (status: SignInStatus, message: string) => useSignIn.setState({ status, message })

const messageOf = (e: unknown, fallback: string) =>
  typeof e === 'object' && e && typeof (e as { message?: unknown }).message === 'string' ? (e as { message: string }).message : fallback

const signInFor = (provider: ProviderId) => {
  try {
    return getAdapter(provider).signIn
  } catch {
    return undefined
  }
}
const siteOf = (provider: ProviderId) => signInFor(provider)?.site ?? provider

/**
 * Open the provider's sign-in in the browser and wait for the result. `connectionId`: sign that one in
 * again; `newAccount`: do not reuse a known account ("Use Another Account").
 */
export async function beginSignIn(provider: ProviderId = 'openrouter', connectionId?: string, newAccount?: boolean): Promise<void> {
  useSignIn.setState({ provider, renewing: connectionId ?? null })
  set('waiting', `Finish signing in to ${siteOf(provider)} in your browser. Novel waits up to 5 minutes.`)
  try {
    await startOAuth(provider, connectionId, newAccount)
  } catch (e) {
    set('failed', messageOf(e, 'The sign-in could not start.'))
  }
}

export async function cancelSignIn(): Promise<void> {
  if (useSignIn.getState().status !== 'waiting') return
  set('idle', '')
  await cancelOAuth().catch(() => {})
}

/** What an `ai-oauth-result` does: read the new connection, and make it the default if there was none. */
export async function handleSignInResult(r: OAuthResult): Promise<void> {
  if (!r.ok) {
    // A cancel the writer asked for is already shown as idle.
    if (useSignIn.getState().status === 'waiting') set('failed', r.error ?? 'The sign-in did not finish.')
    return
  }
  try {
    await loadTutorConnections()
  } catch {
    set('failed', 'Signed in, but the connections could not be read. Reopen Settings.')
    return
  }
  const { list, activeId } = useStore.getState().tutorConnections
  const added = list.find((c) => c.id === r.connectionId)
  if (!added) {
    const provider = useSignIn.getState().provider
    set('done', provider ? `Signed in to ${siteOf(provider)}.` : 'Signed in.')
    return
  }
  if (!activeId) setActiveTutorConnection(added.id)
  const sign = signInFor(added.provider as ProviderId)
  if (useSignIn.getState().renewing === added.id) {
    set('done', `Signed in again. “${added.label}” is ready to use.`)
  } else if (sign?.consumerPlan) {
    // OpenAI's guideline: say once, after the first sign-in, that the plan is now in use and where to manage it.
    set('done', `Signed in. “${added.label}” is ready: the tutor now uses your ${sign.site} plan. Manage Usage shows and limits what it uses.`)
  } else {
    set('done', `Signed in. “${added.label}” is ready to use.`)
  }
}

/** Listen for sign-in results for the life of the app; returns unlisten. */
export function listenForSignIn(): () => void {
  let off: (() => void) | null = null
  let stopped = false
  onOAuthResult((r) => void handleSignInResult(r))
    .then((unlisten) => (stopped ? unlisten() : (off = unlisten)))
    .catch((e: unknown) => console.error('[tutor] the sign-in result cannot be heard', e))
  return () => {
    stopped = true
    off?.()
  }
}

/** Test-only. */
export function __resetSignInForTests(): void {
  useSignIn.setState({ status: 'idle', message: '', provider: null, renewing: null })
}
