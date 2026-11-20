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
 */

export const AI_COMMAND_NAMES = ['ai_fetch', 'ai_fetch_cancel', 'ai_spike_autorun', 'ai_spike_log'] as const

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
  }
  const running = new Map<number, () => void>()
  const earlyCancels = new Set<number>()

  function reset() {
    state.script = null
    state.requests.length = 0
    state.cancels.length = 0
    state.spikeAutorun = false
    state.spikeLog.length = 0
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
      default:
        throw new Error(`unexpected command ${cmd}`)
    }
  }

  return { state, handle, reset }
}
