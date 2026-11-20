/**
 * A `fetch` for the AI SDK that goes through the Rust proxy `ai_fetch` (src-tauri/src/ai) instead of
 * the network: the webview never fetches directly, and the CSP stays closed.
 *
 * Adapters build their SDK provider with the placeholder origin `https://provider.invalid` and pass
 * `fetch: createTauriFetch(connectionId)`. The shim accepts any absolute URL, drops its origin and
 * forwards only path + query; Rust appends them to the connection's real base URL and adds the
 * credential itself. The SDK's dummy credential headers are stripped here (ruling R1) and every
 * header outside Rust's allowlist is dropped there (ruling R2).
 *
 * The response body is a ReadableStream fed by the channel's chunk events. Aborting `init.signal`
 * calls `ai_fetch_cancel` and rejects the pending fetch, or errors the body, with an AbortError.
 */
import { Channel, invoke } from '@tauri-apps/api/core'

export type AiErrorKind =
  | 'not_connected'
  | 'blocked_host'
  | 'bad_request'
  | 'auth'
  | 'rate_limit'
  | 'network'
  | 'provider'
  | 'cancelled'

const KINDS: readonly string[] = [
  'not_connected',
  'blocked_host',
  'bad_request',
  'auth',
  'rate_limit',
  'network',
  'provider',
  'cancelled',
] satisfies AiErrorKind[]

/** A typed proxy failure. The message is for people and never contains a secret. */
export class AiFetchError extends Error {
  readonly kind: AiErrorKind
  constructor(kind: AiErrorKind, message: string) {
    super(message)
    this.name = 'AiFetchError'
    this.kind = kind
  }
}

/** Mirrors Rust's AiFetchEvent (serde tag "type"). */
type AiFetchEvent =
  | { type: 'head'; status: number; headers: [string, string][] }
  | { type: 'chunk'; data: string }
  | { type: 'end' }
  | { type: 'error'; kind: string; message: string }

/** Headers the SDK sets with a dummy key; the real credential is added in Rust. */
const STRIPPED_HEADERS = new Set(['authorization', 'x-api-key', 'api-key'])

/** Statuses a Response may not carry a body for. */
const NULL_BODY_STATUS = new Set([101, 103, 204, 205, 304])

let nextRequestId = 1

function toAiError(e: unknown): AiFetchError {
  if (e instanceof AiFetchError) return e
  if (e && typeof e === 'object' && 'kind' in e && typeof e.kind === 'string' && KINDS.includes(e.kind)) {
    const message = 'message' in e && typeof e.message === 'string' ? e.message : e.kind
    return new AiFetchError(e.kind as AiErrorKind, message)
  }
  return new AiFetchError('network', e instanceof Error ? e.message : String(e))
}

function abortError(signal: AbortSignal): unknown {
  const reason: unknown = signal.reason
  if (reason instanceof Error && reason.name === 'AbortError') return reason
  return new DOMException('The request was aborted.', 'AbortError')
}

function decodeBase64(data: string): Uint8Array {
  const bin = atob(data)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

async function bodyText(body: BodyInit | null | undefined, request: Request | null): Promise<string | undefined> {
  if (body == null) return request && request.body ? await request.text() : undefined
  if (typeof body === 'string') return body
  if (body instanceof Uint8Array || body instanceof ArrayBuffer) return new TextDecoder().decode(body)
  if (ArrayBuffer.isView(body)) return new TextDecoder().decode(new Uint8Array(body.buffer, body.byteOffset, body.byteLength))
  if (body instanceof Blob) return await body.text()
  if (body instanceof URLSearchParams) return body.toString()
  throw new AiFetchError('bad_request', 'This request body type cannot be sent.')
}

/** A `fetch` that sends every request through `ai_fetch` for `connectionId`. */
export function createTauriFetch(connectionId: string): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : null
    const signal = init?.signal ?? request?.signal ?? null
    if (signal?.aborted) throw abortError(signal)

    let url: URL
    try {
      url = new URL(request ? request.url : input instanceof URL ? input.href : String(input))
    } catch {
      throw new AiFetchError('bad_request', 'The request URL is not absolute.')
    }
    const method = (init?.method ?? request?.method ?? 'GET').toUpperCase()
    if (method !== 'GET' && method !== 'POST') throw new AiFetchError('bad_request', `The ${method} method is not allowed.`)
    const headers: [string, string][] = []
    new Headers(init?.headers ?? request?.headers).forEach((value, name) => {
      if (!STRIPPED_HEADERS.has(name)) headers.push([name, value])
    })
    const body = method === 'POST' ? await bodyText(init?.body, request) : undefined

    const requestId = nextRequestId++
    let settled = false
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null
    let finished = false
    /** A provider error that came while chunks were still unread: raised once the reader drains them. */
    let lateError: unknown = null
    let resolveHead!: (r: Response) => void
    let rejectHead!: (e: unknown) => void
    const head = new Promise<Response>((resolve, reject) => {
      resolveHead = resolve
      rejectHead = reject
    })

    /**
     * End the request with an error: reject the fetch, or error the body once it has started. A body
     * error from the provider (`drain`) waits until the chunks already queued are read, so the partial
     * reply is kept (Review Focus 3); erroring a stream at once would throw its queue away. An abort
     * errors at once.
     */
    const fail = (e: unknown, drain = false) => {
      if (finished) return
      finished = true
      signal?.removeEventListener('abort', onAbort)
      if (!settled) {
        settled = true
        rejectHead(e)
        return
      }
      // highWaterMark 0: desiredSize is minus the number of queued chunks.
      if (drain && controller && (controller.desiredSize ?? 0) < 0) {
        lateError = e
        return
      }
      try {
        controller?.error(e)
      } catch {
        // the body was already cancelled by its reader
      }
    }

    const onAbort = () => {
      void invoke('ai_fetch_cancel', { requestId }).catch(() => {})
      fail(abortError(signal!))
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    const channel = new Channel<AiFetchEvent>()
    channel.onmessage = (event) => {
      if (finished) return
      switch (event.type) {
        case 'head': {
          const stream = NULL_BODY_STATUS.has(event.status)
            ? null
            : new ReadableStream<Uint8Array>({
                start: (c) => {
                  controller = c
                },
                // Called when a read finds the queue empty: the late error's turn.
                pull: (c) => {
                  if (lateError !== null) c.error(lateError)
                },
                cancel: () => {
                  // The reader gave up: stop the request too.
                  if (finished) return
                  finished = true
                  signal?.removeEventListener('abort', onAbort)
                  void invoke('ai_fetch_cancel', { requestId }).catch(() => {})
                },
              }, { highWaterMark: 0 })
          settled = true
          resolveHead(new Response(stream, { status: event.status, headers: event.headers }))
          break
        }
        case 'chunk':
          controller?.enqueue(decodeBase64(event.data))
          break
        case 'end':
          finished = true
          signal?.removeEventListener('abort', onAbort)
          if (!settled) {
            settled = true
            rejectHead(new AiFetchError('provider', 'The response ended before it started.'))
          } else {
            controller?.close()
          }
          break
        case 'error':
          fail(toAiError(event), true)
          break
      }
    }

    invoke('ai_fetch', {
      requestId,
      connectionId,
      req: { method, path: url.pathname + url.search, headers, body: body ?? null },
      onEvent: channel,
    }).catch((e: unknown) => fail(toAiError(e)))

    return head
  }
}
