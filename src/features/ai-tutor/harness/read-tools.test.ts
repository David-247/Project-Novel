import type { Editor } from '@tiptap/core'
import type { ToolSet } from 'ai'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useStore, type PageInfo } from '@/shared/store'
import { backend } from '@/test-utils/fake-tauri'

vi.mock('@tauri-apps/api/core', async () => (await import('@/test-utils/fake-tauri')).coreModule)

import { __resetSpellcheckCacheForTests } from '@/features/spellcheck'
import { createParagraphIndex, followEditor, type ParagraphIndex } from './paragraph-index'
import { createReadTools } from './read-tools'
import { blockPosOf, h1, makeEditor, p, t } from './test-doc'

let editor: Editor | null = null
beforeEach(() => {
  backend.reset()
  __resetSpellcheckCacheForTests()
  useStore.getState().layoutActions.resetLayout()
})
afterEach(() => {
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

/** Chapter 1 and Chapter 2; the layout puts the caret's page in Chapter 1. */
function setup() {
  const ed = makeEditor(h1('One'), p(t('I saw teh dog.')), p(t('A quiet morning.')), h1('Two'), p(t('Far teh away.')), p(t('The secret plan.')))
  editor = ed
  const idx = createParagraphIndex(ed)
  followEditor(idx)
  const two = blockPosOf(ed, 'Two')
  useStore.getState().layoutActions.setPages([page(0, 0, two, 0), page(1, two, ed.state.doc.content.size, 1)])
  useStore.getState().layoutActions.setCurrentPage(0)
  return { ed, idx }
}

/** Run a tool the way the AI SDK does. */
async function run(tools: ToolSet, name: string, input: unknown): Promise<unknown> {
  const tool = tools[name]
  if (!tool?.execute) throw new Error(`no tool ${name}`)
  return tool.execute(input as never, { toolCallId: 'call-1', messages: [], context: {} } as never)
}

function tools(idx: ParagraphIndex, attachments: Parameters<typeof createReadTools>[0]['scope']['attachments'] = [], answer = false) {
  const requestRead = vi.fn<(target: string, words: number) => Promise<boolean>>(async () => answer)
  const onScript = vi.fn()
  return { set: createReadTools({ idx, scope: { attachments }, requestRead, onScript }), requestRead, onScript }
}

describe('createReadTools', () => {
  it('offers the five read tools with descriptions and schemas', () => {
    const { idx } = setup()
    const { set } = tools(idx)
    expect(Object.keys(set).sort()).toEqual(['check_grammar', 'check_spelling', 'find_text', 'read_range', 'use_script'])
    for (const tool of Object.values(set)) {
      expect(tool.description).toBeTruthy()
      expect(tool.inputSchema).toBeTruthy()
    }
  })

  it('reads the current chapter without asking when nothing is attached', async () => {
    const { idx } = setup()
    const { set, requestRead } = tools(idx)
    const out = (await run(set, 'read_range', { kind: 'chapter', number: 1 })) as { source: string; text: string; words: number }
    expect(requestRead).not.toHaveBeenCalled()
    expect(out.source).toBe('Chapter 1: One')
    expect(out.text).toContain('I saw teh dog.')
    expect(out.text).toMatch(/^\[p\d+\] One/)
    expect(out.words).toBe(8)
  })

  it('asks before reading outside the scope; a denial returns { denied: true } without the text', async () => {
    const { idx } = setup()
    const { set, requestRead } = tools(idx, [], false)
    const out = await run(set, 'read_range', { kind: 'chapter', number: 2 })
    expect(requestRead).toHaveBeenCalledWith('Chapter 2: Two', 7)
    expect(out).toEqual({ denied: true })
    expect(JSON.stringify(out)).not.toContain('secret')
  })

  it('reads outside the scope after Allow, and does not ask again for it', async () => {
    const { idx } = setup()
    const { set, requestRead } = tools(idx, [], true)
    const out = (await run(set, 'read_range', { kind: 'chapter', number: 2 })) as { text: string }
    expect(out.text).toContain('The secret plan.')
    await run(set, 'read_range', { kind: 'chapter', number: 2 })
    expect(requestRead).toHaveBeenCalledTimes(1)
  })

  it('reads within the attachments without asking, and asks for the current chapter when it is not attached', async () => {
    const { idx } = setup()
    const { set, requestRead } = tools(idx, [{ kind: 'chapter', chapter: 2 }])
    expect(((await run(set, 'read_range', { kind: 'page', number: 2 })) as { text: string }).text).toContain('Far teh away.')
    expect(requestRead).not.toHaveBeenCalled()
    expect(await run(set, 'read_range', { kind: 'chapter', number: 1 })).toEqual({ denied: true })
    expect(requestRead).toHaveBeenCalledWith('Chapter 1: One', 8)
  })

  it('reads the outline (chapter titles) without asking', async () => {
    const { idx } = setup()
    const { set, requestRead } = tools(idx)
    const out = (await run(set, 'read_range', { kind: 'outline' })) as { chapters: { chapter: number; title: string }[] }
    expect(out.chapters.map((c) => [c.chapter, c.title])).toEqual([
      [1, 'One'],
      [2, 'Two'],
    ])
    expect(requestRead).not.toHaveBeenCalled()
  })

  it('reports a chapter that does not exist', async () => {
    const { idx } = setup()
    const { set } = tools(idx)
    expect(await run(set, 'read_range', { kind: 'chapter', number: 9 })).toEqual({ error: 'There is no chapter 9. The book has 2 chapters.' })
  })

  it('check_spelling returns the findings in scope with their Location', async () => {
    const { ed, idx } = setup()
    const { set, requestRead } = tools(idx)
    const out = (await run(set, 'check_spelling', {})) as { findings: { paragraph: string; location: unknown; text: string; suggestions: string[]; kind?: string }[] }
    expect(requestRead).not.toHaveBeenCalled()
    expect(out.findings).toEqual([
      expect.objectContaining({ paragraph: idx.idFor(blockPosOf(ed, 'teh dog')), location: { chapter: 1, paragraph: 1, line: null }, text: 'teh', suggestions: ['the'] }),
    ])
    // Only the current chapter was sent to the engine.
    expect(backend.spell.calls.flatMap((c) => c.blocks.map((b) => b.text))).not.toContain('Far teh away.')
  })

  it('check_grammar returns only grammar findings', async () => {
    const { idx } = setup()
    backend.spell.grammar.set('A quiet', ['An quiet'])
    const { set } = tools(idx)
    const out = (await run(set, 'check_grammar', { kind: 'chapter', number: 1 })) as { findings: { text: string; location: { paragraph: number } }[] }
    expect(out.findings.map((f) => [f.text, f.location.paragraph])).toEqual([['A quiet', 2]])
  })

  it('find_text finds matches in scope with locations, and says nothing about text outside it', async () => {
    const { idx } = setup()
    const { set, requestRead } = tools(idx)
    const out = (await run(set, 'find_text', { query: 'TEH' })) as { matches: { location: { chapter: number }; snippet: string }[] }
    expect(out).toEqual({ matches: [expect.objectContaining({ location: { chapter: 1, paragraph: 1, line: null }, snippet: 'I saw teh dog.' })] })
    expect(JSON.stringify(out)).not.toContain('Far')
    // A word only in the unattached chapter: no match, no count, no hint.
    const none = await run(set, 'find_text', { query: 'secret' })
    expect(none).toEqual({ matches: [] })
    expect(JSON.stringify(none)).not.toMatch(/secret|plan|outside/i)
    expect(requestRead).not.toHaveBeenCalled()
  })

  it('find_text clips snippets to a selection in scope', async () => {
    const { ed, idx } = setup()
    const at = blockPosOf(ed, 'A quiet') + 1
    const { set } = tools(idx, [{ kind: 'selection', from: at + 'A '.length, to: at + 'A quiet'.length }])
    const out = (await run(set, 'find_text', { query: 'quiet' })) as { matches: { snippet: string }[] }
    expect(out.matches.map((m) => m.snippet)).toEqual(['quiet'])
  })

  it('check_spelling drops a finding that straddles the edge of a selection', async () => {
    const { ed, idx } = setup()
    const at = blockPosOf(ed, 'teh dog') + 1
    // "I saw te" is selected: the flagged word "teh" runs past the selection's end.
    const { set } = tools(idx, [{ kind: 'selection', from: at, to: at + 'I saw te'.length }])
    const out = (await run(set, 'check_spelling', {})) as { findings: unknown[] }
    expect(out.findings).toEqual([])
    expect(JSON.stringify(out)).not.toContain('teh')
    // Wholly inside, it is kept.
    const whole = tools(idx, [{ kind: 'selection', from: at, to: at + 'I saw teh'.length }])
    expect(((await run(whole.set, 'check_spelling', {})) as { findings: { text: string }[] }).findings.map((f) => f.text)).toEqual(['teh'])
  })

  it('use_script hands back the script and tells the harness', async () => {
    const { idx } = setup()
    const { set, onScript } = tools(idx)
    const out = (await run(set, 'use_script', { name: 'pacing' })) as { script: string; instructions: string }
    expect(out.script).toBe('pacing')
    expect(out.instructions).toContain('# Pacing and structure')
    expect(onScript).toHaveBeenCalledWith('pacing')
  })
})
