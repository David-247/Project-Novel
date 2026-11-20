/**
 * TEST-ONLY stand-in for the Rust AI network proxy (src-tauri/src/ai), part of the fake Tauri core
 * (./fake-tauri-core.ts) used by Vitest and the e2e backend. Tests script what `ai_fetch` streams:
 *
 *   backend.ai.script = { events: sseResponse(['data: {...}\n\n', 'data: [DONE]\n\n']) }
 *
 * Each event is sent on the request's channel (`onEvent`, anything with an `onmessage` handler) on
 * its own macrotask. `pauseAfter: n` holds the stream after the n-th event until it is cancelled.
 * Like Rust, a failure is sent as an `error` event and also rejects the invoke, and a cancel (also
 * one that overtakes its request) ends the stream with a `cancelled` error. No script means no
 * connection (`not_connected`).
 *
 * The keychain is `state.secrets` (connection id to secret; no command reads it back) and
 * ai-connections.json is `state.connections`. Saving validates like Rust (unknown provider, duplicate
 * id, a bad `baseUrl` for ollama, lmstudio and custom; a hosted provider's `baseUrl` is dropped) and
 * deletes the secrets of removed connections. `failSecrets` makes the keychain commands fail.
 */

export const AI_COMMAND_NAMES = [
  'ai_fetch',
  'ai_fetch_cancel',
  'ai_spike_autorun',
  'ai_spike_log',
  'ai_secret_set',
  'ai_secret_delete',
  'ai_secret_has',
  'ai_connections_get',
  'ai_connections_save',
] as const

/** Mirrors Rust's AiFetchEvent (serde tag "type"). */
export type FakeAiEvent =
  | { type: 'head'; status: number; headers: [string, string][] }
  | { type: 'chunk'; data: string }
  | { type: 'end' }
  | { type: 'error'; kind: string; message: string }

export interface FakeAiRequest {
  method: 'GET' | 'POST'
  path: string
  headers: [string, string][]
  body?: string | null
}

export interface FakeAiScript {
  events: FakeAiEvent[]
  /** Hold the stream after this many events until cancelled. */
  pauseAfter?: number
}

interface ChannelLike {
  onmessage: (event: FakeAiEvent) => void
}

const encoder = new TextEncoder()

const PROVIDERS = ['anthropic', 'openai', 'xai', 'deepseek', 'zhipu', 'qwen', 'openrouter', 'ollama', 'lmstudio', 'custom', 'chatgpt']
const USER_HOSTED = ['ollama', 'lmstudio', 'custom']

/** Mirrors Rust's `check_base_url`: http(s), a host, no user info, query or fragment. */
export function baseUrlProblem(raw: string): string | null {
  if (!raw || [...raw].some((c) => c <= ' ')) return 'it is empty or has spaces'
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return 'it is not a URL'
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'it must start with http:// or https://'
  if (!url.hostname) return 'it has no host'
  if (url.username || url.password) return 'it must not contain a user name or password'
  if (raw.includes('?')) return 'it must not contain a query (?)'
  if (raw.includes('#')) return 'it must not contain a fragment (#)'
  return null
}

/** Base64 of UTF-8 text, as Rust sends chunk bytes. */
export const toBase64Text = (text: string) => btoa(String.fromCharCode(...encoder.encode(text)))

/** A 200 `text/event-stream` response streaming `chunks` (one chunk event each), then end. */
export function sseResponse(chunks: string[]): FakeAiEvent[] {
  return [
    { type: 'head', status: 200, headers: [['content-type', 'text/event-stream']] },
    ...chunks.map((c) => ({ type: 'chunk' as const, data: toBase64Text(c) })),
    { type: 'end' },
  ]
}

export function createFakeAi() {
  const state = {
    /** What the next ai_fetch streams (sticky); null = no connection. */
    script: null as FakeAiScript | null,
    /** Every ai_fetch, in order. */
    requests: [] as { requestId: number; connectionId: string; req: FakeAiRequest }[],
    /** Every ai_fetch_cancel request id, in order. */
    cancels: [] as number[],
    /** ai_spike_autorun's answer, and the ai_spike_log lines. */
    spikeAutorun: false,
    spikeLog: [] as string[],
    /** The OS keychain: connection id to secret. */
    secrets: new Map<string, string>(),
    /** ai-connections.json's connections (plain objects, as Rust returns them). */
    connections: [] as Record<string, unknown>[],
    /** true: ai_secret_* fail as if the keychain were locked. */
    failSecrets: false,
  }
  const running = new Map<number, () => void>()
  const earlyCancels = new Set<number>()

  function reset() {
    state.script = null
    state.requests.length = 0
    state.cancels.length = 0
    state.spikeAutorun = false
    state.spikeLog.length = 0
    state.secrets.clear()
    state.connections = []
    state.failSecrets = false
    running.clear()
    earlyCancels.clear()
  }

  const fail = (kind: string, message: string) => ({ kind, message })

  async function aiFetch(args: Record<string, unknown>) {
    const requestId = args.requestId as number
    const channel = args.onEvent as ChannelLike
    const send = (e: FakeAiEvent) => channel.onmessage(e)
    const failWith = (kind: string, message: string) => {
      send({ type: 'error', kind, message })
      throw fail(kind, message)
    }
    state.requests.push({ requestId, connectionId: args.connectionId as string, req: args.req as FakeAiRequest })
    if (earlyCancels.delete(requestId)) failWith('cancelled', 'The request was cancelled.')
    const script = state.script
    if (!script) failWith('not_connected', 'This AI connection is not set up. Connect a provider in Settings.')
    let cancelled = false
    let wake = () => {}
    running.set(requestId, () => {
      cancelled = true
      wake()
    })
    try {
      for (let i = 0; i < script!.events.length; i++) {
        if (i === script!.pauseAfter) await new Promise<void>((resolve) => (wake = resolve))
        else await new Promise((resolve) => setTimeout(resolve, 0))
        if (cancelled) failWith('cancelled', 'The request was cancelled.')
        const event = script!.events[i]
        send(event)
        if (event.type === 'error') throw fail(event.kind, event.message)
      }
      if (script!.pauseAfter === script!.events.length) await new Promise<void>((resolve) => (wake = resolve))
      if (cancelled) failWith('cancelled', 'The request was cancelled.')
    } finally {
      running.delete(requestId)
    }
    return null
  }

  function checkSecretArgs(args: Record<string, unknown>) {
    const id = args.connectionId
    if (state.failSecrets) throw fail('auth', 'The system keychain is locked or not available.')
    if (typeof id !== 'string' || !id) throw fail('bad_request', 'The connection id is not valid.')
    return id
  }

  function saveConnections(list: Record<string, unknown>[]) {
    const ids = new Set<string>()
    const saved = list.map((c) => {
      const copy = { ...c }
      const id = copy.id
      if (typeof id !== 'string' || !id || ids.has(id)) throw fail('bad_request', 'A connection id is not valid or is used twice.')
      ids.add(id)
      const provider = copy.provider as string
      if (!PROVIDERS.includes(provider)) throw fail('bad_request', 'A connection names an unknown provider.')
      if (typeof copy.label !== 'string' || !copy.label.trim()) throw fail('bad_request', 'A connection label is empty.')
      if (USER_HOSTED.includes(provider)) {
        if (copy.baseUrl !== undefined) {
          copy.baseUrl = String(copy.baseUrl).trim()
          const problem = baseUrlProblem(copy.baseUrl as string)
          if (problem) throw fail('bad_request', `The address is not valid: ${problem}.`)
        }
      } else {
        delete copy.baseUrl
        delete copy.insecureHttpAccepted
      }
      return copy
    })
    for (const old of state.connections) if (!ids.has(old.id as string)) state.secrets.delete(old.id as string)
    state.connections = saved
  }

  async function handle(cmd: string, args: Record<string, unknown>): Promise<unknown> {
    switch (cmd) {
      case 'ai_fetch':
        return aiFetch(args)
      case 'ai_fetch_cancel': {
        const id = args.requestId as number
        state.cancels.push(id)
        const cancel = running.get(id)
        if (cancel) cancel()
        else earlyCancels.add(id)
        return null
      }
      case 'ai_spike_autorun':
        return state.spikeAutorun
      case 'ai_spike_log':
        state.spikeLog.push(args.line as string)
        return null
      case 'ai_secret_set': {
        const id = checkSecretArgs(args)
        if (typeof args.secret !== 'string' || !args.secret) throw fail('bad_request', 'The credential is empty or too long.')
        state.secrets.set(id, args.secret)
        return null
      }
      case 'ai_secret_delete':
        state.secrets.delete(checkSecretArgs(args))
        return null
      case 'ai_secret_has':
        return state.secrets.has(checkSecretArgs(args))
      case 'ai_connections_get':
        return structuredClone(state.connections)
      case 'ai_connections_save':
        saveConnections(structuredClone(args.connections as Record<string, unknown>[]))
        return null
      default:
        throw new Error(`unexpected command ${cmd}`)
    }
  }

  return { state, handle, reset }
}
