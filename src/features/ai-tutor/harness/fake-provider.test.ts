import type { Editor } from '@tiptap/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { backend } from '@/test-utils/fake-tauri'
import { openAiChatStream } from '@/test-utils/fake-ai'

vi.mock('@tauri-apps/api/core', async () => (await import('@/test-utils/fake-tauri')).coreModule)

import { __resetSpellcheckCacheForTests } from '@/features/spellcheck'
import type { Connection } from '../connections/types'
import { createTutorSession, runTutorTurn, type TurnEvent, type TutorSession } from './run-turn'
import { h1, makeEditor, p, t } from './test-doc'

/**
 * The e2e fake provider (src/test-utils/fake-ai.ts `openAiChatStream`, queued per request) drives the
 * REAL OpenAI adapter through the fetch shim and the fake core's ai_fetch: a tool call turn, then text.
 * Guards the e2e scenario against a stream the SDK would not read.
 */
const connection: Connection = { id: 'conn-e2e', provider: 'openai', label: 'OpenAI', auth: 'api_key', defaultModel: 'gpt-6.2-sol' }

let editor: Editor | null = null
let session: TutorSession | null = null
beforeEach(() => {
  backend.reset()
  __resetSpellcheckCacheForTests()
})
afterEach(() => {
  session?.dispose()
  editor?.destroy()
})

describe('the e2e fake provider', () => {
  it('a list_corrections call, then an explanation, through the real adapter', async () => {
    editor = makeEditor(h1('One'), p(t('I saw teh dog.')))
    session = createTutorSession(editor)
    backend.ai.queue.push(
      { events: openAiChatStream({ tools: [{ name: 'list_corrections', input: { items: [{ paragraph: 'p2', kind: 'spelling', original: 'teh', suggestion: 'the', explanation: 'A typo.' }] } }] }) },
      { events: openAiChatStream({ text: '“Teh” is a typo for “the”: the letters are swapped.' }) },
    )
    const events: TurnEvent[] = []
    await runTutorTurn({
      connection,
      modelId: 'gpt-6.2-sol',
      history: [],
      userText: 'Is there a mistake?',
      attachments: [{ kind: 'chapter', chapter: 1 }],
      script: null,
      signal: new AbortController().signal,
      session,
      onEvent: (e) => void events.push(e),
    })
    expect(events.filter((e) => e.type === 'error')).toEqual([])
    const corrections = events.flatMap((e) => (e.type === 'corrections' ? e.items : []))
    expect(corrections.map((c) => [c.original, c.suggestion, c.state])).toEqual([['teh', 'the', 'open']])
    expect(events.flatMap((e) => (e.type === 'text' ? [e.delta] : [])).join('')).toBe('“Teh” is a typo for “the”: the letters are swapped.')
    expect(events.at(-1)).toEqual({ type: 'done', incomplete: false })
    expect(backend.ai.requests.map((r) => `${r.req.method} ${r.req.path} ${r.connectionId}`)).toEqual([
      'POST /chat/completions conn-e2e',
      'POST /chat/completions conn-e2e',
    ])
  })
})
