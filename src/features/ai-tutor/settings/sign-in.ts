import { create } from 'zustand'
import { useStore } from '@/shared/store'
import { loadTutorConnections, setActiveTutorConnection } from '../connections/store'
import { cancelOAuth, onOAuthResult, startOAuth, type OAuthResult } from './ipc'

/**
 * Sign in with OpenRouter, as the settings page shows it. Rust does the whole flow (src-tauri/src/ai/
 * oauth.rs) and reports with the `ai-oauth-result` event; the listener lives as long as the app (the
 * composition root, through registerTutorCommands), so a sign-in finished after Settings was closed still
 * adds its connection.
 */
export type SignInStatus = 'idle' | 'waiting' | 'done' | 'failed'

interface SignInState {
  status: SignInStatus
  /** What the page says about the last sign-in (never a key or a code). */
  message: string
}

export const useSignIn = create<SignInState>()(() => ({ status: 'idle', message: '' }))

const set = (status: SignInStatus, message: string) => useSignIn.setState({ status, message })

const messageOf = (e: unknown, fallback: string) =>
  typeof e === 'object' && e && typeof (e as { message?: unknown }).message === 'string' ? (e as { message: string }).message : fallback

/** Open OpenRouter in the browser and wait for the result. */
export async function beginSignIn(): Promise<void> {
  set('waiting', 'Finish signing in to OpenRouter in your browser. Novel waits up to 5 minutes.')
  try {
    await startOAuth('openrouter')
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
  if (added && !activeId) setActiveTutorConnection(added.id)
  set('done', added ? `Signed in. “${added.label}” is ready to use.` : 'Signed in to OpenRouter.')
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
  set('idle', '')
}
