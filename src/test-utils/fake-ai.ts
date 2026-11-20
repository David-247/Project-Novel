/**
 * TEST-ONLY stand-in for the Rust AI network proxy (src-tauri/src/ai), part of the fake Tauri core
 * (./fake-tauri-core.ts) used by Vitest and the e2e backend. Tests script what `ai_fetch` streams:
 *
 *   backend.ai.script = { events: sseResponse(['data: {...}\n\n', 'data: [DONE]\n\n']) }
 *
 * Each event is sent on the request's channel (`onEvent`, anything with an `onmessage` handler) on
 * its own macrotask (from `burstFrom: n` on, all in one task). `pauseAfter: n` holds the stream after the n-th event until it is cancelled.
 * Like Rust, a failure is sent as an `error` event and also rejects the invoke, and a cancel (also
 * one that overtakes its request) ends the stream with a `cancelled` error. No script means no
 * connection (`not_connected`).
 *
 * The keychain is `state.secrets` (connection id to secret; no command reads it back) and
 * ai-connections.json is `state.connections` (`ai_connection_upsert` / `ai_connection_remove` change one entry of it, as Rust does). Saving validates like Rust (unknown provider, duplicate
 * id, a bad `baseUrl` for ollama, lmstudio and custom; a hosted provider's `baseUrl` is dropped) and
 * deletes the secret of a removed connection or one whose provider, auth or base URL origin changed
 * (a secret can only be set for a saved connection, as in Rust). `failSecrets` makes the keychain commands fail.
 *
 * Chat history (`tutor_history_*`) is `state.history` (project id to chat id to chat) with Rust's id check
 * (`^[A-Za-z0-9-]{1,64}$`) and 8 MB size cap; `historySaves` logs every save, `failHistory` makes the commands fail.
 *
 * Sign in with OpenRouter or ChatGPT: `ai_oauth_start` only records the provider (`oauthStarts`; Rust would
 * open the browser) and, for a renewal, the connection id (`oauthRenewals`). A test finishes the sign-in with
 * `completeOAuth(secret, provider?, name?)` (adds the oauth connection and its secret, as Rust does) and then
 * emits `ai-oauth-result` itself. `ai_open_key_page` records the provider (`keyPages`), `ai_open_usage_page`
 * too (`usagePages`); `oauthCancels` counts `ai_oauth_cancel`. Removing a ChatGPT connection answers whether
 * the sign-out was confirmed (`signOutConfirmed`, default true), as Rust does; any other answers null.
 */

export const AI_COMMAND_NAMES = [
  'ai_fetch',
  'ai_fetch_cancel',
  'ai_secret_set',
  'ai_secret_delete',
  'ai_secret_has',
  'ai_connections_get',
  'ai_connections_save',
  'ai_connection_upsert',
  'ai_connection_remove',
  'tutor_history_list',
  'tutor_history_load',
  'tutor_history_save',
  'tutor_history_delete',
  'tutor_history_clear_all',
  'ai_oauth_start',
  'ai_oauth_cancel',
  'ai_open_key_page',
  'ai_open_usage_page',
  'ai_oauth_reusable',
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
  /** From this event index on, send the events back to back in one task (chunks pile up unread). */
  burstFrom?: number
  /**
   * After the events, reject the invoke with this error without sending an `error` event first: the
   * rejection races the channel (Rust's command result can arrive before the channel's last events).
   */
  rejectWith?: { kind: string; message: string }
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

/** One OpenAI chat-completions stream chunk (`data: {...}`) with `delta` and an optional finish reason. */
function chatChunk(delta: Record<string, unknown>, finish: string | null = null): string {
  return `data: ${JSON.stringify({ id: 'chatcmpl-fake', object: 'chat.completion.chunk', created: 0, model: 'fake', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
}

/**
 * The fake provider for e2e (and its Vitest check): an OpenAI Chat Completions stream (what the openai,
 * compatible and local adapters read) that says `text` in a few deltas and/or calls `tools`, then ends.
 */
export function openAiChatStream(reply: { text?: string; tools?: { name: string; input: unknown }[] }): FakeAiEvent[] {
  const chunks: string[] = [chatChunk({ role: 'assistant', content: '' })]
  const words = reply.text ? reply.text.match(/\S+\s*/g) ?? [] : []
  for (let i = 0; i < words.length; i += 3) chunks.push(chatChunk({ content: words.slice(i, i + 3).join('') }))
  ;(reply.tools ?? []).forEach((t, index) =>
    chunks.push(chatChunk({ tool_calls: [{ index, id: `call_${index + 1}`, type: 'function', function: { name: t.name, arguments: JSON.stringify(t.input) } }] })),
  )
  chunks.push(chatChunk({}, reply.tools?.length ? 'tool_calls' : 'stop'))
  chunks.push('data: [DONE]\n\n')
  return sseResponse(chunks)
}

export function createFakeAi() {
  const state = {
    /** What the next ai_fetch streams (sticky); null = no connection. */
    script: null as FakeAiScript | null,
    /** Scripts for the next requests, one each, in order (before `script`): a turn's model calls. */
    queue: [] as FakeAiScript[],
    /** Every ai_fetch, in order. */
    requests: [] as { requestId: number; connectionId: string; req: FakeAiRequest }[],
    /** Every ai_fetch_cancel request id, in order. */
    cancels: [] as number[],
    /** The OS keychain: connection id to secret. */
    secrets: new Map<string, string>(),
    /** ai-connections.json's connections (plain objects, as Rust returns them). */
    connections: [] as Record<string, unknown>[],
    /** true: ai_secret_* fail as if the keychain were locked. */
    failSecrets: false,
    /** tutor-history in the app data dir: project id to chat id to chat. */
    history: new Map<string, Map<string, Record<string, unknown>>>(),
    /** Every tutor_history_save, in order (the project id and a copy of the chat). */
    historySaves: [] as { projectId: string; chat: Record<string, unknown> }[],
    /** true: tutor_history_* fail. */
    failHistory: false,
    /** Every ai_oauth_start provider, in order. */
    oauthStarts: [] as string[],
    oauthCancels: 0,
    /** Every ai_open_key_page provider, in order. */
    keyPages: [] as string[],
    /** Every ai_oauth_start renewal's connection id, in order. */
    oauthRenewals: [] as string[],
    /** Every ai_open_usage_page provider, in order. */
    usagePages: [] as string[],
    /** What removing a ChatGPT (plan sign-in) connection answers: the provider confirmed the sign-out. */
    signOutConfirmed: true,
    /** What `ai_oauth_reusable` answers for ChatGPT: the known account's email, or null (none). */
    reusableAccount: null as string | null,
    /** Every ai_oauth_start that asked for another account ("Use Another Account"), by provider. */
    oauthNewAccounts: [] as string[],
  }
  const running = new Map<number, () => void>()
  const earlyCancels = new Set<number>()

  function reset() {
    state.script = null
    state.queue.length = 0
    state.requests.length = 0
    state.cancels.length = 0
    state.secrets.clear()
    state.connections = []
    state.failSecrets = false
    state.history.clear()
    state.historySaves.length = 0
    state.failHistory = false
    state.oauthStarts.length = 0
    state.oauthCancels = 0
    state.keyPages.length = 0
    state.oauthRenewals.length = 0
    state.usagePages.length = 0
    state.signOutConfirmed = true
    state.reusableAccount = null
    state.oauthNewAccounts.length = 0
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
    const script = state.queue.shift() ?? state.script
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
        else if (script!.burstFrom === undefined || i <= script!.burstFrom) await new Promise((resolve) => setTimeout(resolve, 0))
        if (cancelled) failWith('cancelled', 'The request was cancelled.')
        const event = script!.events[i]
        send(event)
        if (event.type === 'error') throw fail(event.kind, event.message)
      }
      if (script!.pauseAfter === script!.events.length) await new Promise<void>((resolve) => (wake = resolve))
      if (cancelled) failWith('cancelled', 'The request was cancelled.')
      if (script!.rejectWith) throw fail(script!.rejectWith.kind, script!.rejectWith.message)
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

  const originOf = (u: unknown) => {
    try {
      return new URL(String(u)).origin
    } catch {
      return ''
    }
  }
  /** What a secret is tied to (Rust's `binding`): provider, auth and the request origin. */
  const binding = (c: Record<string, unknown>) =>
    `${c.provider}|${c.auth}|${USER_HOSTED.includes(c.provider as string) && c.baseUrl !== undefined ? originOf(c.baseUrl) : ''}`

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
    for (const old of state.connections) {
      const now = saved.find((c) => c.id === old.id)
      if (!now || binding(now) !== binding(old)) state.secrets.delete(old.id as string)
    }
    state.connections = saved
  }

  const MAX_CHAT_BYTES = 8 * 1024 * 1024
  const RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i // Windows device names, refused like Rust
  const validId = (id: unknown): id is string => typeof id === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(id) && !RESERVED.test(id)

  function historyCommand(cmd: string, args: Record<string, unknown>): unknown {
    if (state.failHistory) throw fail('bad_request', 'The chat history could not be read.')
    if (cmd === 'tutor_history_clear_all') {
      state.history.clear()
      return null
    }
    if (!validId(args.projectId)) throw fail('bad_request', 'The project id is not valid.')
    const chats = state.history.get(args.projectId)
    switch (cmd) {
      case 'tutor_history_list':
        return [...(chats?.values() ?? [])]
          .map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt }))
          .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)) || String(a.id).localeCompare(String(b.id)))
      case 'tutor_history_load': {
        if (!validId(args.chatId)) throw fail('bad_request', 'The chat id is not valid.')
        const chat = chats?.get(args.chatId)
        if (!chat) throw fail('bad_request', 'The chat history could not be read.')
        return structuredClone(chat)
      }
      case 'tutor_history_save': {
        const chat = structuredClone(args.chat) as Record<string, unknown>
        if (!validId(chat?.id)) throw fail('bad_request', 'The chat id is not valid.')
        if (JSON.stringify(chat).length > MAX_CHAT_BYTES) throw fail('bad_request', 'This chat is too large to save. Start a new chat.')
        const bucket = chats ?? new Map<string, Record<string, unknown>>()
        bucket.set(chat.id, chat)
        state.history.set(args.projectId, bucket)
        state.historySaves.push({ projectId: args.projectId, chat: structuredClone(chat) })
        return null
      }
      default: {
        // tutor_history_delete: one chat, or (no chatId) the project's folder.
        if (args.chatId == null) state.history.delete(args.projectId)
        else if (!validId(args.chatId)) throw fail('bad_request', 'The chat id is not valid.')
        else chats?.delete(args.chatId)
        return null
      }
    }
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
      case 'ai_secret_set': {
        const id = checkSecretArgs(args)
        if (typeof args.secret !== 'string' || !args.secret) throw fail('bad_request', 'The credential is empty or too long.')
        if (!state.connections.some((c) => c.id === id)) throw fail('not_connected', 'This AI connection is not set up. Connect a provider in Settings.')
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
      case 'ai_connection_upsert': {
        // As Rust: merged into the stored list, so other connections (and their keys) are kept.
        const c = structuredClone(args.connection as Record<string, unknown>)
        const list = state.connections.some((x) => x.id === c.id) ? state.connections.map((x) => (x.id === c.id ? c : x)) : [...state.connections, c]
        saveConnections(structuredClone(list))
        return null
      }
      case 'ai_connection_remove': {
        const gone = state.connections.find((x) => x.id === args.connectionId)
        const plan = gone?.provider === 'chatgpt' && gone.auth === 'oauth' && state.secrets.has(gone.id as string)
        saveConnections(structuredClone(state.connections.filter((x) => x.id !== args.connectionId)))
        return plan ? state.signOutConfirmed : null
      }
      case 'tutor_history_list':
      case 'tutor_history_load':
      case 'tutor_history_save':
      case 'tutor_history_delete':
      case 'tutor_history_clear_all':
        return historyCommand(cmd, args)
      case 'ai_oauth_start': {
        const provider = String(args.provider)
        if (provider !== 'openrouter' && provider !== 'chatgpt') throw fail('bad_request', 'This provider has no sign-in.')
        if (args.connectionId !== undefined) {
          if (provider !== 'chatgpt') throw fail('bad_request', 'This provider cannot sign a connection in again.')
          const c = state.connections.find((x) => x.id === args.connectionId)
          if (!c || c.provider !== provider || !state.secrets.has(c.id as string)) {
            throw fail('bad_request', 'This connection has no ChatGPT sign-in to renew. Remove it, then Continue with ChatGPT.')
          }
          state.oauthRenewals.push(c.id as string)
        }
        if (args.newAccount !== undefined) {
          if (provider !== 'chatgpt' || args.connectionId !== undefined) throw fail('bad_request', 'Sign In Again renews the same account.')
          state.oauthNewAccounts.push(provider)
        }
        state.oauthStarts.push(provider)
        return null
      }
      case 'ai_oauth_reusable':
        return args.provider === 'chatgpt' ? state.reusableAccount : null
      case 'ai_open_usage_page': {
        if (args.provider !== 'chatgpt') throw fail('bad_request', 'This provider has no usage page.')
        state.usagePages.push(args.provider)
        return null
      }
      case 'ai_oauth_cancel':
        state.oauthCancels++
        return null
      case 'ai_open_key_page': {
        const provider = String(args.provider)
        if (['ollama', 'lmstudio', 'custom', 'chatgpt'].includes(provider) || !PROVIDERS.includes(provider)) throw fail('bad_request', 'This provider has no key page.')
        state.keyPages.push(provider)
        return null
      }
      default:
        throw new Error(`unexpected command ${cmd}`)
    }
  }

  /**
   * Finish a sign-in as Rust does: a new oauth connection of `provider` named `name` (then "name 2", ...)
   * with `secret` in the keychain (OpenRouter: the key; ChatGPT: Rust's token record). Returns its id.
   */
  function completeOAuth(secret: string, provider: 'openrouter' | 'chatgpt' = 'openrouter', name = provider === 'chatgpt' ? 'ChatGPT' : 'OpenRouter'): string {
    const taken = new Set(state.connections.map((c) => c.label))
    let label = name
    for (let n = 2; taken.has(label); n++) label = `${name} ${n}`
    const id = `${provider}-${state.connections.length + 1}x${Math.random().toString(36).slice(2, 8)}`
    state.connections = [...state.connections, { id, provider, label, auth: 'oauth' }]
    state.secrets.set(id, secret)
    return id
  }

  return { state, handle, reset, completeOAuth }
}
