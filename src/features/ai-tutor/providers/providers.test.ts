import { beforeEach, describe, expect, it, vi } from 'vitest'
import { backend } from '@/test-utils/fake-tauri'
import { sseResponse, toBase64Text, type FakeAiEvent } from '@/test-utils/fake-ai'
import { PROVIDER_IDS, type Connection, type ProviderId } from '../connections/types'
import { getAdapter, listAdapters, modelSupportsTools } from './registry'

vi.mock('@tauri-apps/api/core', async () => (await import('@/test-utils/fake-tauri')).coreModule)

const conn = (provider: ProviderId, extra: Partial<Connection> = {}): Connection => ({
  id: `c-${provider}`,
  provider,
  label: provider,
  auth: 'api_key',
  ...extra,
})

/** A 200 JSON response, as `ai_fetch` would stream it. */
const jsonResponse = (body: unknown): FakeAiEvent[] => [
  { type: 'head', status: 200, headers: [['content-type', 'application/json']] },
  { type: 'chunk', data: toBase64Text(JSON.stringify(body)) },
  { type: 'end' },
]

const chatChunk = (delta: Record<string, unknown>, finish: string | null = null) =>
  `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`

const chatCompletion = (message: Record<string, unknown>) => ({
  id: 'c',
  object: 'chat.completion',
  created: 0,
  model: 'm',
  choices: [{ index: 0, message: { role: 'assistant', ...message }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
})

const callOptions = { prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }

async function drain(stream: ReadableStream<unknown>) {
  const reader = stream.getReader()
  while (!(await reader.read()).done);
}

/** The path each adapter's `doStream` must hit: Rust's descriptor base URL already holds any `/v1` prefix. */
const STREAM_PATHS: [ProviderId, string][] = [
  ['anthropic', '/messages'],
  ['openai', '/chat/completions'],
  ['xai', '/responses'],
  ['deepseek', '/chat/completions'],
  ['zhipu', '/chat/completions'],
  ['qwen', '/chat/completions'],
  ['openrouter', '/chat/completions'],
  ['ollama', '/chat/completions'],
  ['lmstudio', '/chat/completions'],
  ['custom', '/chat/completions'],
]

beforeEach(() => backend.reset())

describe('registry', () => {
  it('has one adapter per provider the proxy serves, except the ChatGPT sign-in (Task 12)', () => {
    const ids = listAdapters().map((a) => a.id)
    expect(ids).toEqual(PROVIDER_IDS.filter((id) => id !== 'chatgpt'))
    for (const id of ids) expect(getAdapter(id).id).toBe(id)
    expect(() => getAdapter('chatgpt')).toThrow()
  })

  it('offers a probe only for the local and custom providers', () => {
    for (const a of listAdapters()) {
      expect(typeof a.probeTools === 'function', a.id).toBe(['ollama', 'lmstudio', 'custom'].includes(a.id))
    }
  })

  it('curates a short list of tool-capable models for each hosted provider with a fixed list', async () => {
    for (const id of ['anthropic', 'openai', 'xai', 'deepseek', 'zhipu', 'qwen'] as const) {
      const models = await getAdapter(id).listModels(conn(id))
      expect(models.length, id).toBeGreaterThan(0)
      expect(models.length, id).toBeLessThanOrEqual(5)
      for (const m of models) expect(m.tools, `${id}/${m.id}`).toBe('yes')
    }
  })
})

describe('adapters route through the proxy', () => {
  it.each(STREAM_PATHS)('%s: doStream hits %s, with no credential header', async (provider, path) => {
    backend.ai.script = { events: sseResponse([provider === 'anthropic' ? 'event: message_stop\ndata: {"type":"message_stop"}\n\n' : 'data: [DONE]\n\n']) }
    const c = conn(provider, provider === 'ollama' || provider === 'lmstudio' || provider === 'custom' ? { baseUrl: 'http://localhost:1/v1' } : {})
    const model = getAdapter(provider).languageModel(c, 'some-model') as unknown as {
      doStream(o: typeof callOptions): Promise<{ stream: ReadableStream<unknown> }>
    }
    const { stream } = await model.doStream(callOptions)
    await drain(stream)

    expect(backend.ai.requests).toHaveLength(1)
    const { connectionId, req } = backend.ai.requests[0]
    expect(connectionId).toBe(c.id)
    expect(req.method).toBe('POST')
    expect(req.path).toBe(path)
    const names = req.headers.map(([n]) => n.toLowerCase())
    for (const secret of ['authorization', 'x-api-key', 'api-key']) expect(names, provider).not.toContain(secret)
    expect(JSON.stringify(req.headers)).not.toContain('from-keychain')
    expect(JSON.stringify(req.body ?? '')).toContain('some-model')
  })

  it('lists models for a user-hosted connection with GET /models', async () => {
    backend.ai.script = { events: jsonResponse({ data: [{ id: 'llama3' }, { id: 'qwen3' }] }) }
    const models = await getAdapter('ollama').listModels(conn('ollama', { auth: 'none', baseUrl: 'http://localhost:11434/v1' }))
    expect(models.map((m) => m.id)).toEqual(['llama3', 'qwen3'])
    expect(models.every((m) => m.tools === 'unknown')).toBe(true)
    expect(backend.ai.requests[0].req).toMatchObject({ method: 'GET', path: '/models' })
  })

  it('reads tool support from OpenRouter model metadata', async () => {
    backend.ai.script = {
      events: jsonResponse({
        data: [
          { id: 'a/with-tools', name: 'With tools', supported_parameters: ['temperature', 'tools'] },
          { id: 'b/no-tools', supported_parameters: ['temperature'] },
        ],
      }),
    }
    const models = await getAdapter('openrouter').listModels(conn('openrouter'))
    expect(models).toEqual([
      { id: 'a/with-tools', label: 'With tools', tools: 'yes' },
      { id: 'b/no-tools', label: 'b/no-tools', tools: 'no' },
    ])
  })
})

describe('hosted listModels', () => {
  it('merges the curated list (first, tools kept) with the provider models, extras unknown', async () => {
    backend.ai.script = { events: jsonResponse({ data: [{ id: 'gpt-extra' }, { id: 'gpt-6.2-sol' }, { id: 'gpt-other', display_name: 'Other' }] }) }
    const curatedIds = (await (async () => { backend.ai.script = null; return getAdapter('openai').listModels(conn('openai')) })()).map((m) => m.id)
    backend.ai.script = { events: jsonResponse({ data: [{ id: 'gpt-extra' }, { id: 'gpt-6.2-sol' }, { id: 'gpt-other', display_name: 'Other' }] }) }
    const models = await getAdapter('openai').listModels(conn('openai'))
    expect(models.map((m) => m.id)).toEqual([...curatedIds, 'gpt-extra', 'gpt-other'])
    expect(models.filter((m) => curatedIds.includes(m.id)).every((m) => m.tools === 'yes')).toBe(true)
    expect(models.slice(curatedIds.length)).toEqual([
      { id: 'gpt-extra', label: 'gpt-extra', tools: 'unknown' },
      { id: 'gpt-other', label: 'Other', tools: 'unknown' },
    ])
    expect(backend.ai.requests[0].req).toMatchObject({ method: 'GET', path: '/models' })
  })

  it('does not trust the provider to mark extra ids as tool-capable', async () => {
    backend.ai.script = { events: jsonResponse({ data: [{ id: 'new-model', supported_parameters: ['tools'] }] }) }
    const models = await getAdapter('anthropic').listModels(conn('anthropic'))
    const extra = models.find((m) => m.id === 'new-model')!
    expect(extra.tools).toBe('unknown')
    expect(modelSupportsTools(conn('anthropic'), extra)).toBe(false)
    expect(modelSupportsTools(conn('anthropic', { toolSupport: { 'new-model': true } }), extra)).toBe(true)
  })

  it.each([
    ['a failing request', [{ type: 'error', kind: 'provider', message: 'boom' }] as FakeAiEvent[]],
    ['an HTTP error', [{ type: 'head', status: 500, headers: [] }, { type: 'end' }] as FakeAiEvent[]],
    ['a malformed body', [{ type: 'head', status: 200, headers: [] }, { type: 'chunk', data: toBase64Text('not json') }, { type: 'end' }] as FakeAiEvent[]],
  ])('falls back to the curated list on %s', async (_name, events) => {
    backend.ai.script = { events }
    const models = await getAdapter('deepseek').listModels(conn('deepseek'))
    expect(models.map((m) => m.id)).toEqual(['deepseek-v4-pro', 'deepseek-flash'])
    expect(models.every((m) => m.tools === 'yes')).toBe(true)
  })
})

describe('modelSupportsTools', () => {
  const m = (tools: 'yes' | 'no' | 'unknown') => ({ id: 'm1', label: 'm1', tools })

  it('prefers the user override over the listed answer', () => {
    expect(modelSupportsTools(conn('custom', { toolSupport: { m1: false } }), m('yes'))).toBe(false)
    expect(modelSupportsTools(conn('custom', { toolSupport: { m1: true } }), m('no'))).toBe(true)
  })

  it('falls back to the curated or probed answer, and to false when unknown', () => {
    expect(modelSupportsTools(conn('openai'), m('yes'))).toBe(true)
    expect(modelSupportsTools(conn('openai'), m('no'))).toBe(false)
    expect(modelSupportsTools(conn('custom'), m('unknown'))).toBe(false)
    expect(modelSupportsTools(conn('custom', { toolSupport: { other: true } }), m('unknown'))).toBe(false)
  })
})

describe('probeTools', () => {
  const local = conn('ollama', { auth: 'none', baseUrl: 'http://localhost:11434/v1' })

  it('is true when the scripted reply is a tool call, and sends the ping tool', async () => {
    backend.ai.script = {
      events: jsonResponse(
        chatCompletion({ content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'ping', arguments: '{}' } }] }),
      ),
    }
    expect(await getAdapter('ollama').probeTools!(local, 'llama3')).toBe(true)
    const body = JSON.parse(backend.ai.requests[0].req.body ?? '{}')
    expect(body.tools[0].function.name).toBe('ping')
  })

  it('is false for a plain text reply', async () => {
    backend.ai.script = { events: jsonResponse(chatCompletion({ content: 'pong' })) }
    expect(await getAdapter('lmstudio').probeTools!({ ...local, provider: 'lmstudio' }, 'm')).toBe(false)
  })

  it('is false when the request fails', async () => {
    backend.ai.script = { events: [{ type: 'error', kind: 'provider', message: 'boom' }] }
    expect(await getAdapter('custom').probeTools!({ ...local, provider: 'custom' }, 'm')).toBe(false)
  })

  it('does not send a streamed text-only reply as a tool call', async () => {
    backend.ai.script = { events: sseResponse([chatChunk({ content: 'hi' }, 'stop'), 'data: [DONE]\n\n']) }
    expect(await getAdapter('custom').probeTools!({ ...local, provider: 'custom' }, 'm')).toBe(false)
  })
})
