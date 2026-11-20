import type { Editor } from '@tiptap/core'
import type { ModelMessage } from 'ai'
import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useStore, type PageInfo } from '@/shared/store'
import { backend } from '@/test-utils/fake-tauri'
import { sseResponse } from '@/test-utils/fake-ai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'

vi.mock('@tauri-apps/api/core', async () => (await import('@/test-utils/fake-tauri')).coreModule)

const hoisted = vi.hoisted(() => ({ model: null as unknown }))
vi.mock('../providers/registry', () => ({
  getAdapter: () => ({ languageModel: () => hoisted.model }),
}))

import { __resetSpellcheckCacheForTests } from '@/features/spellcheck'
import type { Connection } from '../connections/types'
import { AiFetchError, createTauriFetch } from '../net/tauri-fetch'
import { CHARTER_SOURCE, promptText, scriptText } from './assemble'
import { EXPLAIN_INSTEAD } from './output-tools'
import { createTutorSession, runTutorTurn, type TurnEvent, type TutorSession } from './run-turn'
import { blockPosOf, h1, makeEditor, p, t, textPosOf } from './test-doc'

type LanguageModelV4CallOptions = Parameters<MockLanguageModelV4['doStream']>[0]
type LanguageModelV4StreamPart = Awaited<ReturnType<MockLanguageModelV4['doStream']>>['stream'] extends ReadableStream<infer P> ? P : never

const connection: Connection = { id: 'conn-1', provider: 'openai', label: 'OpenAI', auth: 'api_key' }

let editor: Editor | null = null
let session: TutorSession | null = null
beforeEach(() => {
  backend.reset()
  __resetSpellcheckCacheForTests()
  useStore.getState().layoutActions.resetLayout()
})
afterEach(() => {
  session?.dispose()
  session = null
  editor?.destroy()
  editor = null
  useStore.getState().layoutActions.resetLayout()
})

const page = (index: number, from: number, to: number, chapterIndex: number): PageInfo => ({
  index,
  side: index % 2 === 0 ? 'recto' : 'verso',
  from,
  to,
  isBlank: false,
  startsBlockType: null,
  chapterIndex,
})

function setup() {
  const ed = makeEditor(h1('One'), p(t('I saw teh dog.')), p(t('The rain fell on the town all night.')), h1('Two'), p(t('Far away.')))
  editor = ed
  const two = blockPosOf(ed, 'Two')
  useStore.getState().layoutActions.setPages([page(0, 0, two, 0), page(1, two, ed.state.doc.content.size, 1)])
  useStore.getState().layoutActions.setCurrentPage(0)
  session = createTutorSession(ed)
  const dog = session.idx.idFor(blockPosOf(ed, 'teh dog'))
  const rain = session.idx.idFor(blockPosOf(ed, 'The rain'))
  return { ed, session, dog, rain }
}

const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } }
const finish = (unified: 'stop' | 'tool-calls'): LanguageModelV4StreamPart => ({ type: 'finish', finishReason: { unified, raw: unified }, usage })
const text = (...deltas: string[]): LanguageModelV4StreamPart[] => [{ type: 'text-start', id: 't' }, ...deltas.map((delta) => ({ type: 'text-delta' as const, id: 't', delta })), { type: 'text-end', id: 't' }]
let callId = 0
const call = (toolName: string, input: unknown): LanguageModelV4StreamPart => ({ type: 'tool-call', toolCallId: `call-${++callId}`, toolName, input: JSON.stringify(input) })

type Step = LanguageModelV4StreamPart[] | ((options: LanguageModelV4CallOptions) => ReadableStream<LanguageModelV4StreamPart> | Promise<never>)

/** A model that plays `steps`, one per model call. */
function scripted(...steps: Step[]): MockLanguageModelV4 {
  let n = 0
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      const step = steps[n++]
      if (!step) throw new Error('the script ran out')
      const stream = typeof step === 'function' ? await step(options) : convertArrayToReadableStream(step)
      return { stream }
    },
  })
  hoisted.model = model
  return model
}

async function turn(over: Partial<Parameters<typeof runTutorTurn>[0]> = {}) {
  const events: TurnEvent[] = []
  const controller = new AbortController()
  const messages = await runTutorTurn({
    connection,
    modelId: 'gpt-test',
    history: [],
    userText: 'Check my grammar.',
    attachments: [],
    script: null,
    signal: controller.signal,
    session: session ?? undefined,
    onEvent: (e) => {
      events.push(e)
    },
    ...over,
  })
  return { events, messages }
}

const ofType = <K extends TurnEvent['type']>(events: TurnEvent[], type: K) => events.filter((e): e is Extract<TurnEvent, { type: K }> => e.type === type)

/** The system prompt and tool results a model call received. */
function systemOf(options: LanguageModelV4CallOptions): string {
  return options.prompt.filter((m) => m.role === 'system').map((m) => m.content as string).join('\n')
}
function toolResultsOf(options: LanguageModelV4CallOptions): unknown[] {
  return options.prompt.flatMap((m) => (m.role === 'tool' ? m.content.map((c) => (c.type === 'tool-result' ? c.output : null)) : []))
}

describe('runTutorTurn', () => {
  it('runs a scripted tool sequence into corrections and proposal events', async () => {
    const { dog, rain } = setup()
    const model = scripted(
      [
        call('list_corrections', { items: [{ paragraph: dog, kind: 'spelling', original: 'teh', suggestion: 'the', explanation: 'A typo.' }] }),
        call('propose_change', { paragraphIds: [rain], revisedText: ['The rain fell on the town all night long.'], reason: 'Example.' }),
        finish('tool-calls'),
      ],
      [...text('I listed one ', 'fix.'), finish('stop')],
    )
    const { events, messages } = await turn({ attachments: [{ kind: 'chapter', chapter: 1 }] })

    const corrections = ofType(events, 'corrections')
    expect(corrections).toHaveLength(1)
    expect(corrections[0].items).toEqual([
      { id: 'c1', paragraphId: dog, location: { chapter: 1, paragraph: 1, line: null }, kind: 'spelling', original: 'teh', suggestion: 'the', explanation: 'A typo.', state: 'open' },
    ])
    expect(ofType(events, 'proposal')).toEqual([{ type: 'proposal', change: { paragraphIds: [rain], revisedText: ['The rain fell on the town all night long.'], reason: 'Example.' } }])
    expect(ofType(events, 'tool').map((e) => `${e.name}:${e.status}`)).toEqual(['list_corrections:start', 'propose_change:start', 'list_corrections:done', 'propose_change:done'])
    expect(ofType(events, 'text').map((e) => e.delta).join('')).toBe('I listed one fix.')
    expect(events.at(-1)).toEqual({ type: 'done', incomplete: false })
    expect(ofType(events, 'error')).toEqual([])

    // The charter comes first, then book facts; the manuscript goes in the user message, as data.
    const system = systemOf(model.doStreamCalls[0])
    expect(system.startsWith(promptText(CHARTER_SOURCE))).toBe(true)
    expect(system).toContain('<book-facts>')
    // Messages as sent: the user's (with the attached text), then the reply with its tool round trip.
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
    expect(messages[0].content).toMatch(/^<manuscript source="Chapter 1: One">\n[\s\S]*I saw teh dog\.[\s\S]*<\/manuscript>\n\nCheck my grammar\.$/)
    expect(JSON.stringify(messages.at(-1))).toContain('I listed one fix.')
  })

  it('answers a rejected propose_change with the instruction and emits no proposal', async () => {
    const { rain } = setup()
    const model = scripted(
      [call('propose_change', { paragraphIds: [rain], revisedText: ['The storm battered the sleeping village all night.'], reason: 'Better.' }), finish('tool-calls')],
      [...text('Here is why the sentence drags.'), finish('stop')],
    )
    const { events } = await turn()
    expect(ofType(events, 'proposal')).toEqual([])
    expect(toolResultsOf(model.doStreamCalls[1])).toEqual([{ type: 'json', value: { rejected: 'too_many_words', instruction: EXPLAIN_INSTEAD } }])
    expect(EXPLAIN_INSTEAD).toBe('Explain this in chat instead.')
    expect(events.at(-1)).toEqual({ type: 'done', incomplete: false })
  })

  it('guards each correction suggestion and lists only those that pass', async () => {
    const { dog, rain } = setup()
    const model = scripted(
      [
        call('list_corrections', {
          items: [
            { paragraph: rain, kind: 'style', original: 'The rain fell on the town', suggestion: 'A storm lashed the sleeping village', explanation: 'Stronger.' },
            { paragraph: dog, kind: 'spelling', original: 'teh', suggestion: 'the', explanation: 'A typo.' },
            { paragraph: dog, kind: 'spelling', original: 'nowhere', suggestion: 'x', explanation: '?' },
            { paragraph: 'p99', kind: 'spelling', original: 'a', suggestion: 'b', explanation: '?' },
          ],
        }),
        finish('tool-calls'),
      ],
      [...text('Done.'), finish('stop')],
    )
    const { events } = await turn()
    expect(ofType(events, 'corrections').flatMap((e) => e.items.map((c) => c.original))).toEqual(['teh'])
    const [result] = toolResultsOf(model.doStreamCalls[1]) as { value: { listed: string[]; rejected: { item: number; rejected: string; instruction: string }[] } }[]
    expect(result.value.listed).toEqual(['c1'])
    expect(result.value.rejected.map((r) => [r.item, r.rejected])).toEqual([
      [0, 'too_many_words'],
      [2, 'not_found'],
      [3, 'unknown_paragraph'],
    ])
    expect(result.value.rejected[0].instruction).toBe(EXPLAIN_INSTEAD)
  })

  it('rejects an original that occurs more than once in its paragraph, asking for more context', async () => {
    const ed = makeEditor(h1('One'), p(t('The cat sat by their door and their gate.')))
    editor = ed
    session = createTutorSession(ed)
    const id = session.idx.idFor(blockPosOf(ed, 'The cat'))
    const model = scripted(
      [
        call('list_corrections', {
          items: [
            { paragraph: id, kind: 'grammar', original: 'their', suggestion: 'there', explanation: 'Ambiguous.' },
            { paragraph: id, kind: 'grammar', original: 'by their', suggestion: 'by the', explanation: 'Unique.' },
          ],
        }),
        finish('tool-calls'),
      ],
      [...text('Done.'), finish('stop')],
    )
    const { events } = await turn()
    expect(ofType(events, 'corrections').flatMap((e) => e.items.map((c) => c.original))).toEqual(['by their'])
    const [result] = toolResultsOf(model.doStreamCalls[1]) as { value: { rejected: { item: number; rejected: string; instruction: string }[] } }[]
    expect(result.value.rejected).toHaveLength(1)
    expect(result.value.rejected[0]).toMatchObject({ item: 0, rejected: 'ambiguous' })
    expect(result.value.rejected[0].instruction).toMatch(/more than once/)
  })

  it('allows a paragraph-style change with the text unchanged, and rejects an unknown style', async () => {
    const { dog } = setup()
    scripted(
      [
        call('propose_change', { paragraphIds: [dog], revisedText: ['I saw teh dog.'], reason: 'Not a heading.', style: 'no such style' }),
        call('propose_change', { paragraphIds: [dog], revisedText: ['I saw teh dog.'], reason: 'Make it a chapter title.', style: 'Chapter Title' }),
        finish('tool-calls'),
      ],
      [...text('Done.'), finish('stop')],
    )
    const { events } = await turn()
    const proposals = ofType(events, 'proposal')
    expect(proposals).toHaveLength(1)
    expect(proposals[0].change.revisedText).toEqual(['I saw teh dog.'])
    expect(proposals[0].change.style).toBeTruthy()
  })

  it('appends the script chosen with use_script on the next step', async () => {
    setup()
    const model = scripted([call('use_script', { name: 'proofread' }), finish('tool-calls')], [...text('Proofreading.'), finish('stop')])
    await turn()
    expect(systemOf(model.doStreamCalls[0])).not.toContain(scriptText('proofread'))
    const second = systemOf(model.doStreamCalls[1])
    expect(second.startsWith(promptText(CHARTER_SOURCE))).toBe(true)
    expect(second).toContain(scriptText('proofread'))
  })

  it('asks the writer through a read-request event before reading outside the scope', async () => {
    setup()
    const model = scripted([call('read_range', { kind: 'chapter', number: 2 }), finish('tool-calls')], [...text('Read it.'), finish('stop')])
    const events: TurnEvent[] = []
    await runTutorTurn({
      connection,
      modelId: 'm',
      history: [],
      userText: 'Look at chapter 2.',
      attachments: [],
      script: null,
      signal: new AbortController().signal,
      session: session!,
      onEvent: (e) => {
        events.push(e)
        if (e.type === 'read-request') e.respond(true)
      },
    })
    expect(ofType(events, 'read-request').map((e) => e.target)).toEqual(['Chapter 2: Two'])
    expect(JSON.stringify(toolResultsOf(model.doStreamCalls[1]))).toContain('Far away.')
  })

  it('ends with done{incomplete:true} on abort, keeping what streamed', async () => {
    setup()
    scripted((options) => {
      return new ReadableStream<LanguageModelV4StreamPart>({
        start(c) {
          c.enqueue({ type: 'text-start', id: 't' })
          c.enqueue({ type: 'text-delta', id: 't', delta: 'Partly ' })
          options.abortSignal?.addEventListener('abort', () => c.error(new DOMException('The request was aborted.', 'AbortError')))
        },
      })
    })
    const controller = new AbortController()
    const events: TurnEvent[] = []
    const messages = await runTutorTurn({
      connection,
      modelId: 'm',
      history: [{ role: 'user', content: 'Earlier.' }, { role: 'assistant', content: 'Earlier reply.' }],
      userText: 'Hello',
      attachments: [],
      script: null,
      signal: controller.signal,
      session: session!,
      onEvent: (e) => {
        events.push(e)
        if (e.type === 'text') controller.abort()
      },
    })
    expect(events.at(-1)).toEqual({ type: 'done', incomplete: true })
    expect(ofType(events, 'error')).toEqual([])
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(messages.at(-1)).toEqual({ role: 'assistant', content: 'Partly ' })
  })

  it('maps a 429 mid-stream to error{kind:rate_limit} and keeps the partial text (Review Focus 3)', async () => {
    setup()
    scripted(() => {
      // The body errors after a chunk was read, as the proxy's stream does on a late error event.
      let pulls = 0
      return new ReadableStream<LanguageModelV4StreamPart>({
        pull(c) {
          const n = pulls++
          if (n === 0) c.enqueue({ type: 'text-start', id: 't' })
          else if (n === 1) c.enqueue({ type: 'text-delta', id: 't', delta: 'The first half' })
          else c.error(new AiFetchError('rate_limit', 'The provider is limiting requests. Try again in a moment.'))
        },
      })
    })
    const { events, messages } = await turn()
    expect(ofType(events, 'text').map((e) => e.delta)).toEqual(['The first half'])
    expect(ofType(events, 'error')).toEqual([{ type: 'error', kind: 'rate_limit', message: 'The provider is limiting requests. Try again in a moment.' }])
    expect(events.at(-1)).toEqual({ type: 'done', incomplete: true })
    expect(messages.at(-1)).toEqual({ role: 'assistant', content: 'The first half' })
  })

  it('keeps every delta queued ahead of a late proxy error, through the real fetch shim (Review Focus 3)', async () => {
    setup()
    const sse = (content: string) =>
      `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] })}

`
    // The head, then three chunks and the error in one task: the chunks are still queued when it arrives.
    backend.ai.script = {
      events: [...sseResponse([sse('The first '), sse('half and '), sse('the tail')]).slice(0, 4), { type: 'error', kind: 'rate_limit', message: 'Slow down.' }],
      burstFrom: 1,
    }
    hoisted.model = createOpenAICompatible({ name: 'test', baseURL: 'https://provider.invalid/v1', apiKey: 'x', fetch: createTauriFetch('conn-1') }).chatModel('m')
    const { events, messages } = await turn()
    expect(ofType(events, 'text').map((e) => e.delta).join('')).toBe('The first half and the tail')
    expect(events.slice(-2)).toEqual([
      { type: 'error', kind: 'rate_limit', message: 'Slow down.' },
      { type: 'done', incomplete: true },
    ])
    expect(messages.at(-1)).toEqual({ role: 'assistant', content: 'The first half and the tail' })
  })

  it('maps a 429 before any reply (the request rejected) to error{kind:rate_limit}', async () => {
    setup()
    scripted(() => Promise.reject(new AiFetchError('rate_limit', 'Too many requests.')))
    const { events, messages } = await turn()
    expect(ofType(events, 'error')).toEqual([{ type: 'error', kind: 'rate_limit', message: 'Too many requests.' }])
    expect(events.at(-1)).toEqual({ type: 'done', incomplete: true })
    expect(messages.map((m) => m.role)).toEqual(['user'])
  })

  it('makes one call to the provider: no SDK retries', async () => {
    setup()
    const model = scripted(() => Promise.reject(new AiFetchError('network', 'Offline.')))
    await turn()
    expect(model.doStreamCalls).toHaveLength(1)
  })

  it('marks corrections changed when the writer edits during the turn (Review Focus 2)', async () => {
    const { ed, dog } = setup()
    scripted(
      [call('list_corrections', { items: [{ paragraph: dog, kind: 'spelling', original: 'teh', suggestion: 'the', explanation: 'A typo.' }] }), finish('tool-calls')],
      () => {
        // The writer types in the paragraph while the reply streams.
        ed.commands.insertContentAt(textPosOf(ed, 'dog'), 'big ')
        return convertArrayToReadableStream([...text('Done.'), finish('stop')])
      },
    )
    const { events } = await turn()
    const lists = ofType(events, 'corrections')
    expect(lists.map((e) => e.items.map((c) => `${c.id}:${c.state}`))).toEqual([['c1:open'], ['c1:changed']])
    expect(session!.corrections.get('c1')?.state).toBe('changed')
  })

  it('keeps tracking after the turn: an edit then marks the correction changed for the session', async () => {
    const { ed, dog, rain } = setup()
    scripted(
      [
        call('list_corrections', {
          items: [
            { paragraph: dog, kind: 'spelling', original: 'teh', suggestion: 'the', explanation: 'A typo.' },
            { paragraph: rain, kind: 'punctuation', original: 'night.', suggestion: 'night!', explanation: 'Emphasis.' },
          ],
        }),
        finish('tool-calls'),
      ],
      [...text('Done.'), finish('stop')],
    )
    const { events } = await turn()
    const seen: string[][] = []
    session!.corrections.subscribe((items) => seen.push(items.map((c) => `${c.id}:${c.state}`)))
    // An edit in another paragraph leaves the correction open; one in its paragraph changes it.
    ed.commands.insertContentAt(textPosOf(ed, 'night'), 'long ')
    expect(seen).toEqual([['c2:changed']])
    expect(session!.corrections.get('c1')?.state).toBe('open')
    // The turn's onEvent is not called after the turn.
    expect(ofType(events, 'corrections')).toHaveLength(1)
    // An edit elsewhere does not move the other; it still resolves to its paragraph.
    expect(session!.idx.resolve(dog)).toEqual({ from: blockPosOf(ed, 'teh dog'), to: blockPosOf(ed, 'teh dog') + ed.state.doc.nodeAt(blockPosOf(ed, 'teh dog'))!.nodeSize })
  })

  it('turns a throwing paragraph lookup into a rejection, not a crash', async () => {
    const { dog } = setup()
    const idFor = session!.idx.resolve.bind(session!.idx)
    session!.idx.resolve = () => {
      throw new Error('No paragraph at position 0.')
    }
    const model = scripted([call('propose_change', { paragraphIds: [dog], revisedText: ['I saw the dog.'], reason: 'Typo.' }), finish('tool-calls')], [...text('Sorry.'), finish('stop')])
    const { events } = await turn()
    session!.idx.resolve = idFor
    expect(toolResultsOf(model.doStreamCalls[1])).toEqual([{ type: 'json', value: { rejected: 'error', instruction: EXPLAIN_INSTEAD } }])
    expect(events.at(-1)).toEqual({ type: 'done', incomplete: false })
  })

  it('returns the history with the new messages', async () => {
    setup()
    scripted([...text('Hi.'), finish('stop')])
    const history: ModelMessage[] = [{ role: 'user', content: 'Earlier.' }, { role: 'assistant', content: 'Earlier reply.' }]
    const { messages } = await turn({ history, userText: 'Hello' })
    expect(messages.slice(0, 3)).toEqual([...history, { role: 'user', content: 'Hello' }])
    expect(messages).toHaveLength(4)
  })
})
