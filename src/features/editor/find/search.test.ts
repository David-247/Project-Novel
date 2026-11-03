import { getSchema } from '@tiptap/core'
import type { JSONContent } from '@tiptap/core'
import { EditorState } from '@tiptap/pm/state'
import { describe, expect, it, vi } from 'vitest'
import { createEditorExtensions } from '../extensions'
import { buildMatcher, findMatches, indexAtOrAfter, replaceAllRanges, replaceRange, wordCharBefore } from './search'

const schema = getSchema(createEditorExtensions())
const ci = { caseSensitive: false, wholeWord: false }

function docOf(...paras: JSONContent[][]) {
  return schema.nodeFromJSON({
    type: 'doc',
    content: paras.map((content) => ({ type: 'paragraph', content })),
  })
}
const t = (text: string, marks?: string[]): JSONContent => ({
  type: 'text',
  text,
  ...(marks ? { marks: marks.map((type) => ({ type })) } : {}),
})

function texts(doc: ReturnType<typeof docOf>, query: string, opts = ci) {
  return findMatches(doc, query, opts).map((m) => doc.textBetween(m.from, m.to))
}

describe('findMatches', () => {
  it('returns nothing for an empty query', () => {
    expect(findMatches(docOf([t('anything')]), '', ci)).toEqual([])
    expect(buildMatcher('', ci)).toBeNull()
  })

  it('is case-insensitive by default and case-sensitive on request', () => {
    const doc = docOf([t('The cat. the CAT. tHe')])
    expect(texts(doc, 'the')).toEqual(['The', 'the', 'tHe'])
    expect(texts(doc, 'the', { caseSensitive: true, wholeWord: false })).toEqual(['the'])
    expect(texts(docOf([t('École école')]), 'ÉCOLE')).toEqual(['École', 'école'])
  })

  it('whole word ignores matches inside other words (unicode-aware)', () => {
    const doc = docOf([t('cat concatenate cat. cats _cat café cat')])
    expect(texts(doc, 'cat', { caseSensitive: false, wholeWord: true })).toEqual(['cat', 'cat', 'cat'])
    expect(texts(doc, 'caf', { caseSensitive: false, wholeWord: true })).toEqual([])
    expect(texts(doc, 'cat')).toHaveLength(6)
  })

  it('treats regex-special characters literally', () => {
    const doc = docOf([t('a.b(c)*? [x] {1} $1 ^ | \\ / a+b axb')])
    for (const q of ['a.b(c)*?', '[x]', '{1}', '$1', '^', '|', '\\', '/', 'a+b']) {
      expect(texts(doc, q)).toEqual([q])
    }
    expect(texts(doc, '.')).toHaveLength(1)
  })

  it('finds matches spanning mark boundaries and maps them to exact positions', () => {
    const doc = docOf([t('Hello wor'), t('ld', ['bold']), t(' and the w'), t('or', ['italic']), t('ld')])
    const ms = findMatches(doc, 'world', ci)
    expect(ms).toHaveLength(2)
    expect(ms.map((m) => doc.textBetween(m.from, m.to))).toEqual(['world', 'world'])
    expect(ms[0]).toEqual({ from: 1 + 6, to: 1 + 11 })
  })

  it('computes positions across paragraphs and lists, never across blocks or hard breaks', () => {
    const doc = schema.nodeFromJSON({
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 1 }, content: [t('One fish')] },
        { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [t('two fish')] }] }] },
        { type: 'paragraph', content: [t('red'), { type: 'hardBreak' }, t('fish blue fish')] },
        { type: 'paragraph' },
      ],
    })
    expect(texts(doc, 'fish')).toEqual(['fish', 'fish', 'fish', 'fish'])
    expect(findMatches(doc, 'fishtwo', ci)).toEqual([])
    expect(findMatches(doc, 'redfish', ci)).toEqual([])
    expect(findMatches(doc, 'red\nfish', ci)).toEqual([])
  })

  it('whole word uses no regex lookbehind (unsupported on WebKit < 16.4)', () => {
    const re = buildMatcher('cat', { caseSensitive: false, wholeWord: true })!
    expect(re.source).not.toContain('(?<')
  })

  it('whole word retries overlapping candidates after a rejected start', () => {
    const ww = { caseSensitive: false, wholeWord: true }
    // "a a" at 1 is rejected (preceded by "b"); the overlapping candidate at 3 is accepted.
    expect(findMatches(docOf([t('ba a a')]), 'a a', ww)).toEqual([{ from: 1 + 3, to: 1 + 6 }])
    const aa = findMatches(docOf([t('aaa aa')]), 'aa', ww)
    expect(aa).toEqual([{ from: 1 + 4, to: 1 + 6 }])
  })

  it('whole word handles astral (surrogate-pair) characters before a match', () => {
    const ww = { caseSensitive: false, wholeWord: true }
    // U+1D400 MATHEMATICAL BOLD CAPITAL A is a letter; U+1F600 (emoji) is not.
    expect(texts(docOf([t('\u{1D400}cat cat')]), 'cat', ww)).toEqual(['cat'])
    expect(findMatches(docOf([t('\u{1D400}cat cat')]), 'cat', ww)[0].from).toBe(1 + 6)
    expect(texts(docOf([t('\u{1F600}cat')]), 'cat', ww)).toEqual(['cat'])
    expect(wordCharBefore('\u{1D400}x', 2)).toBe(true)
    expect(wordCharBefore('\u{1F600}x', 2)).toBe(false)
    expect(wordCharBefore('x', 0)).toBe(false)
    // Rejected candidate right after an astral letter, retried by code point.
    expect(texts(docOf([t('a\u{1D400} \u{1D400}')]), '\u{1D400}', ww)).toEqual(['\u{1D400}'])
  })

  it('never throws: a failing scan yields no matches', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const broken = {
      descendants: () => {
        throw new Error('boom')
      },
    } as unknown as ReturnType<typeof docOf>
    expect(findMatches(broken, 'x', ci)).toEqual([])
    expect(err).toHaveBeenCalled()
    err.mockRestore()
  })

  it('finds non-overlapping successive matches', () => {
    expect(texts(docOf([t('aaaa')]), 'aa')).toEqual(['aa', 'aa'])
  })

  it('indexAtOrAfter picks the first match at/after a position and wraps', () => {
    const ms = [
      { from: 5, to: 7 },
      { from: 10, to: 12 },
    ]
    expect(indexAtOrAfter(ms, 0)).toBe(0)
    expect(indexAtOrAfter(ms, 5)).toBe(0)
    expect(indexAtOrAfter(ms, 6)).toBe(1)
    expect(indexAtOrAfter(ms, 11)).toBe(0)
    expect(indexAtOrAfter([], 3)).toBe(-1)
  })
})

describe('replace', () => {
  it('replaceRange keeps the marks of the first matched character', () => {
    const doc = docOf([t('a '), t('bo', ['bold']), t('ld z')])
    const state = EditorState.create({ schema, doc })
    const [m] = findMatches(doc, 'bold', ci)
    const tr = replaceRange(state.tr, schema, m, 'BRAVE')
    const para = tr.doc.firstChild!
    expect(para.textContent).toBe('a BRAVE z')
    const brave = para.child(1)
    expect(brave.text).toBe('BRAVE')
    expect(brave.marks.map((mk) => mk.type.name)).toEqual(['bold'])
  })

  it('replaceRange with an empty replacement deletes the match', () => {
    const doc = docOf([t('one two three')])
    const state = EditorState.create({ schema, doc })
    const [m] = findMatches(doc, ' two', ci)
    expect(replaceRange(state.tr, schema, m, '').doc.textContent).toBe('one three')
  })

  it('replaceAllRanges replaces end-to-start in one transaction', () => {
    const doc = docOf([t('cat and cat')], [t('the c'), t('at', ['italic'])])
    const state = EditorState.create({ schema, doc })
    const tr = replaceAllRanges(state.tr, schema, findMatches(doc, 'cat', ci), 'tiger')
    expect(tr.doc.child(0).textContent).toBe('tiger and tiger')
    expect(tr.doc.child(1).textContent).toBe('the tiger')
    // Marks follow the first matched char: "c" was plain, so "tiger" is plain.
    expect(tr.doc.child(1).lastChild!.marks).toEqual([])
    expect(tr.steps).toHaveLength(3)
  })
})
