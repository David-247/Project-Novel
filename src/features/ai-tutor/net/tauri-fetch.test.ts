import { beforeEach, describe, expect, it, vi } from 'vitest'
import { streamText } from 'ai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { backend } from '@/test-utils/fake-tauri'
import { sseResponse } from '@/test-utils/fake-ai'
import { AiFetchError, createTauriFetch } from './tauri-fetch'

vi.mock('@tauri-apps/api/core', async () => (await import('@/test-utils/fake-tauri')).coreModule)

/** One OpenAI chat-completions stream chunk carrying `content`. */
const delta = (content: string, finish: string | null = null) =>
  `data: ${JSON.stringify({
    id: 'c',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'm',
    choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: finish }],
  })}\n\n`

const model = (connectionId = 'c1') =>
  createOpenAICompatible({
    name: 'test',
    baseURL: 'https://provider.invalid/v1',
    apiKey: 'from-keychain',
    fetch: createTauriFetch(connectionId),
  }).chatModel('m')

const decoder = new TextDecoder()

beforeEach(() => backend.reset())

describe('createTauriFetch', () => {
  it('keeps the chunks queued ahead of a late error: the body errors only once they are read', async () => {
    backend.ai.script = {
      events: [...sseResponse(['one ', 'two ', 'three']).slice(0, 4), { type: 'error', kind: 'rate_limit', message: 'Slow down.' }],
      burstFrom: 1,
    }
    const res = await createTauriFetch('c1')('https://provider.invalid/v1/chat/completions', { method: 'POST', body: '{}' })
    // Let the burst (three chunks and the error) arrive before anything is read.
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
    const reader = res.body!.getReader()
    const got: string[] = []
    let error: unknown = null
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        got.push(decoder.decode(value))
      }
    } catch (e) {
      error = e
    }
    expect(got.join('')).toBe('one two three')
    expect(error).toBeInstanceOf(AiFetchError)
    expect((error as AiFetchError).kind).toBe('rate_limit')
  })

  it('keeps the queued chunks when the invoke rejects before any error event (a rejection racing the channel)', async () => {
    backend.ai.script = {
      events: sseResponse(['one ', 'two ', 'three']).slice(0, 4),
      burstFrom: 1,
      rejectWith: { kind: 'network', message: 'The connection dropped.' },
    }
    const res = await createTauriFetch('c1')('https://provider.invalid/v1/chat/completions', { method: 'POST', body: '{}' })
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
    const reader = res.body!.getReader()
    const got: string[] = []
    let error: unknown = null
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        got.push(decoder.decode(value))
      }
    } catch (e) {
      error = e
    }
    expect(got.join('')).toBe('one two three')
    expect(error).toBeInstanceOf(AiFetchError)
    expect((error as AiFetchError).kind).toBe('network')
  })

  /** Read the whole body; the text read and the error it ended with, if any. */
  const drain = async (res: Response) => {
    const reader = res.body!.getReader()
    let text = ''
    let error: unknown = null
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        text += decoder.decode(value)
      }
    } catch (e) {
      error = e
    }
    return { text, error }
  }

  it('an invoke rejection that overtakes the whole stream still gives the reply, in order, then its error', async () => {
    const reply = sseResponse(['one ', 'two ', 'three'])
    backend.ai.script = {
      events: [],
      rejectWith: { kind: 'provider', message: 'The provider stopped.' },
      afterReject: [...reply.slice(0, 4), { type: 'error', kind: 'provider', message: 'The provider stopped.' }],
    }
    const res = await createTauriFetch('c1')('https://provider.invalid/v1/chat/completions', { method: 'POST', body: '{}' })
    expect(res.status).toBe(200)
    const { text, error } = await drain(res)
    expect(text).toBe('one two three')
    expect(error).toBeInstanceOf(AiFetchError)
    expect((error as AiFetchError).kind).toBe('provider')
  })

  it('an invoke rejection mid-stream keeps the chunks the channel has yet to deliver', async () => {
    const reply = sseResponse(['one ', 'two ', 'three'])
    backend.ai.script = {
      events: reply.slice(0, 2),
      rejectWith: { kind: 'network', message: 'The connection dropped.' },
      afterReject: [...reply.slice(2, 4), { type: 'error', kind: 'network', message: 'The connection dropped.' }],
    }
    const res = await createTauriFetch('c1')('https://provider.invalid/v1/chat/completions', { method: 'POST', body: '{}' })
    const { text, error } = await drain(res)
    expect(text).toBe('one two three')
    expect((error as AiFetchError).kind).toBe('network')
  })

  it('an invoke rejection with no channel event at all still rejects the fetch', async () => {
    backend.ai.script = { events: [], rejectWith: { kind: 'auth', message: 'Signed out.' } }
    const e = await createTauriFetch('c1')('https://provider.invalid/v1/models').catch((x: unknown) => x)
    expect(e).toBeInstanceOf(AiFetchError)
    expect((e as AiFetchError).kind).toBe('auth')
  })

  it('streams the scripted SSE text deltas through streamText in order', async () => {
    backend.ai.script = { events: sseResponse([delta('Hel'), delta('lo, '), delta('writer', 'stop') + 'data: [DONE]\n\n']) }
    const result = streamText({ model: model(), prompt: 'hi' })
    const parts: string[] = []
    for await (const t of result.textStream) parts.push(t)
    expect(parts).toEqual(['Hel', 'lo, ', 'writer'])

    expect(backend.ai.requests).toHaveLength(1)
    const { connectionId, req } = backend.ai.requests[0]
    expect(connectionId).toBe('c1')
    expect(req.method).toBe('POST')
    expect(req.path).toBe('/v1/chat/completions')
    expect(JSON.parse(req.body!)).toMatchObject({ model: 'm', stream: true })
    const names = req.headers.map(([k]) => k.toLowerCase())
    expect(names).toContain('content-type')
    for (const auth of ['authorization', 'x-api-key', 'api-key']) expect(names).not.toContain(auth)
  })

  it('forwards only path and query, from any absolute URL', async () => {
    backend.ai.script = { events: sseResponse(['ok']) }
    const f = createTauriFetch('c2')
    const res = await f(new URL('https://provider.invalid/api/tags?x=1&y=2'), {
      headers: { Authorization: 'Bearer x', 'X-Api-Key': 'k', 'api-key': 'k', accept: 'application/json' },
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/event-stream')
    expect(await res.text()).toBe('ok')
    const { req } = backend.ai.requests[0]
    expect(req).toMatchObject({ method: 'GET', path: '/api/tags?x=1&y=2' })
    expect(req.headers).toEqual([['accept', 'application/json']])
  })

  it('accepts a Request object and a byte body', async () => {
    backend.ai.script = { events: sseResponse(['ok']) }
    const f = createTauriFetch('c1')
    await f(new Request('https://provider.invalid/v1/x', { method: 'POST', body: '{"a":1}' }))
    await f('https://provider.invalid/v1/y', { method: 'POST', body: new TextEncoder().encode('{"b":2}') })
    expect(backend.ai.requests.map((r) => r.req.body)).toEqual(['{"a":1}', '{"b":2}'])
  })

  it('abort() mid-stream calls ai_fetch_cancel and rejects with AbortError', async () => {
    backend.ai.script = { events: sseResponse([delta('Hel'), delta('lo'), delta('!', 'stop')]), pauseAfter: 2 }
    const controller = new AbortController()
    const res = await createTauriFetch('c1')('https://provider.invalid/v1/chat/completions', {
      method: 'POST',
      body: '{}',
      signal: controller.signal,
    })
    const reader = res.body!.getReader()
    const first = await reader.read()
    expect(decoder.decode(first.value)).toBe(delta('Hel'))
    controller.abort()
    await expect(reader.read()).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(backend.ai.cancels).toEqual([backend.ai.requests[0].requestId]))
  })

  it('abort() through streamText stops the stream and cancels the request', async () => {
    backend.ai.script = { events: sseResponse([delta('Hel'), delta('lo'), delta('!', 'stop')]), pauseAfter: 2 }
    const controller = new AbortController()
    const errors: unknown[] = []
    const result = streamText({ model: model(), prompt: 'hi', abortSignal: controller.signal, onError: ({ error }) => void errors.push(error) })
    const parts: string[] = []
    const consumed = (async () => {
      for await (const t of result.textStream) {
        parts.push(t)
        controller.abort()
      }
    })()
    await consumed.catch((e: unknown) => errors.push(e))
    expect(parts).toEqual(['Hel'])
    await vi.waitFor(() => expect(backend.ai.cancels).toHaveLength(1))
  })

  it('rejects at once, without a request, when the signal is already aborted', async () => {
    backend.ai.script = { events: sseResponse(['ok']) }
    const controller = new AbortController()
    controller.abort()
    await expect(createTauriFetch('c1')('https://provider.invalid/v1/x', { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(backend.ai.requests).toHaveLength(0)
  })

  it("an Error{kind:'rate_limit'} event surfaces as AiFetchError with kind rate_limit", async () => {
    backend.ai.script = { events: [{ type: 'error', kind: 'rate_limit', message: 'slow down (HTTP 429)' }] }
    const err = await createTauriFetch('c1')('https://provider.invalid/v1/chat/completions', { method: 'POST', body: '{}' }).catch(
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(AiFetchError)
    expect(err).toMatchObject({ kind: 'rate_limit', message: 'slow down (HTTP 429)' })

    // Through the SDK too: the typed error reaches the caller.
    const errors: unknown[] = []
    const result = streamText({ model: model(), prompt: 'hi', maxRetries: 0, onError: ({ error }) => void errors.push(error) })
    await result.consumeStream()
    expect(errors.some((e) => e instanceof AiFetchError && e.kind === 'rate_limit')).toBe(true)
  })

  it('a mid-stream error errors the body with AiFetchError', async () => {
    backend.ai.script = {
      events: [
        { type: 'head', status: 200, headers: [] },
        { type: 'chunk', data: btoa('data: x\n\n') },
        { type: 'error', kind: 'network', message: 'The connection to host failed.' },
      ],
    }
    const res = await createTauriFetch('c1')('https://provider.invalid/v1/x', { method: 'POST', body: '{}' })
    const err = await res.text().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AiFetchError)
    expect(err).toMatchObject({ kind: 'network' })
  })

  it('no connection is not_connected; an unsupported method is bad_request', async () => {
    await expect(createTauriFetch('none')('https://provider.invalid/v1/x')).rejects.toMatchObject({ kind: 'not_connected' })
    await expect(createTauriFetch('c1')('https://provider.invalid/v1/x', { method: 'DELETE' })).rejects.toMatchObject({
      kind: 'bad_request',
    })
    await expect(createTauriFetch('c1')('/relative/path')).rejects.toMatchObject({ kind: 'bad_request' })
  })
})
