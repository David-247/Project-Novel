/**
 * The live suite's stand-in for `@tauri-apps/api/core` (scripts/tutor-live-eval.mjs only; never app
 * code). The app's adapters, fetch shim and harness run unchanged; only `ai_fetch` is answered here by a
 * plain Node `fetch` to the provider, doing what Rust's proxy does (src-tauri/src/ai/fetch.rs): the host
 * and auth from the descriptor table, the forwarded-header allowlist, the credential added last, a
 * non-2xx answer turned into a typed error. Every other command goes to the fake core (the spell checker
 * fake answers check_spelling and check_grammar).
 *
 * The key is never printed: provider error excerpts have it cut out before they are shown.
 */
import { coreModule as fake } from '@/test-utils/fake-tauri'
// @ts-expect-error plain JS module without types
import { liveConnections, readDescriptors } from './env.mjs'

interface LiveConnection {
  id: string
  provider: string
  key: string | null
  baseUrl: string | null
  model: string | null
}
interface Descriptor {
  baseUrl: string | null
  auth: string
  extraHeaders: [string, string][]
}
interface Channel {
  onmessage: (event: unknown) => void
}

const descriptors = readDescriptors() as Map<string, Descriptor>
const connections = new Map<string, LiveConnection>((liveConnections(process.env, descriptors) as LiveConnection[]).map((c) => [c.id, c]))

/** Rust's FORWARDED_HEADERS (ruling R2). */
const FORWARDED = new Set(['content-type', 'accept', 'anthropic-beta', 'openai-beta'])
const running = new Map<number, AbortController>()

const fail = (kind: string, message: string) => ({ kind, message })
const toBase64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64')

function redact(text: string, key: string | null): string {
  return key ? text.split(key).join('[key]') : text
}

async function aiFetch(args: Record<string, unknown>): Promise<null> {
  const requestId = args.requestId as number
  const channel = args.onEvent as Channel
  const req = args.req as { method: string; path: string; headers: [string, string][]; body?: string | null }
  const send = (e: unknown) => channel.onmessage(e)
  const error = (kind: string, message: string) => {
    send({ type: 'error', kind, message })
    return fail(kind, message)
  }
  const conn = connections.get(args.connectionId as string)
  const d = conn ? descriptors.get(conn.provider) : undefined
  if (!conn || !d) throw error('not_connected', 'This AI connection is not set up.')
  const base = (d.baseUrl ?? conn.baseUrl ?? '').replace(/\/+$/, '')
  if (!req.path.startsWith('/') || req.path.includes('://') || req.path.includes('..')) throw error('bad_request', 'The request path is not valid.')

  const headers = new Headers()
  for (const [name, value] of req.headers) if (FORWARDED.has(name.toLowerCase())) headers.append(name, value)
  for (const [name, value] of d.extraHeaders) headers.set(name, value)
  if (conn.key && d.auth === 'bearer') headers.set('authorization', `Bearer ${conn.key}`)
  else if (conn.key && d.auth !== 'none') headers.set(d.auth, conn.key)

  const controller = new AbortController()
  running.set(requestId, controller)
  const host = new URL(base).host
  try {
    let res: Response
    try {
      res = await fetch(base + req.path, { method: req.method, headers, body: req.method === 'POST' ? (req.body ?? undefined) : undefined, signal: controller.signal })
    } catch {
      if (controller.signal.aborted) throw error('cancelled', 'The request was cancelled.')
      throw error('network', `Could not connect to ${host}.`)
    }
    if (!res.ok) {
      const excerpt = redact((await res.text().catch(() => '')).slice(0, 400), conn.key).replace(/\s+/g, ' ').trim()
      if (res.status === 401 || res.status === 403) throw error('auth', `${host} did not accept the credential (HTTP ${res.status}).`)
      if (res.status === 429) throw error('rate_limit', `${host} is rate limiting requests (HTTP 429).`)
      throw error('provider', `${host} returned an error (HTTP ${res.status})${excerpt ? `: ${excerpt}` : ''}`)
    }
    const head: [string, string][] = []
    res.headers.forEach((value, name) => {
      if (name !== 'set-cookie') head.push([name, value])
    })
    send({ type: 'head', status: res.status, headers: head })
    if (res.body) {
      try {
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) send({ type: 'chunk', data: toBase64(chunk) })
      } catch {
        if (controller.signal.aborted) throw error('cancelled', 'The request was cancelled.')
        throw error('network', `The connection to ${host} failed.`)
      }
    }
    send({ type: 'end' })
    return null
  } finally {
    running.delete(requestId)
  }
}

function invoke(cmd: string, args: Record<string, unknown> = {}, options?: { headers?: unknown }): Promise<unknown> {
  if (cmd === 'ai_fetch') return aiFetch(args)
  if (cmd === 'ai_fetch_cancel') {
    running.get(args.requestId as number)?.abort()
    return Promise.resolve(null)
  }
  return fake.invoke(cmd, args, options)
}

export const coreModule = { ...fake, invoke }
export const liveConnectionList = (): LiveConnection[] => [...connections.values()]
