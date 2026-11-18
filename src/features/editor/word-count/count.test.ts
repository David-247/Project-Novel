import { getSchema, type JSONContent } from '@tiptap/core'
import { Fragment, Slice, type Node as PMNode } from '@tiptap/pm/model'
import { describe, expect, it } from 'vitest'
import { getChapters } from '../breaks/chapters'
import { createEditorExtensions } from '../extensions'
import { countManuscript, countRange, wordCountRecounts } from './count'

const schema = getSchema(createEditorExtensions())
const doc = (...content: JSONContent[]): PMNode => schema.nodeFromJSON({ type: 'doc', content })
const text = (t: string, marks?: JSONContent['marks']): JSONContent => ({ type: 'text', text: t, ...(marks ? { marks } : {}) })
const p = (...content: (JSONContent | string)[]): JSONContent => ({ type: 'paragraph', content: content.map((c) => (typeof c === 'string' ? text(c) : c)) })
const h1 = (t: string): JSONContent => ({ type: 'heading', attrs: { level: 1 }, content: [text(t)] })
const fn = (t: string, marks?: JSONContent['marks']): JSONContent => ({ type: 'footnote', content: [text(t)], ...(marks ? { marks } : {}) })
const change = { id: 'c1', author: 'Ann', date: '2026-01-01' }
const ins = [{ type: 'insertion', attrs: change }]
const del = [{ type: 'deletion', attrs: change }]

describe('manuscript counts (editor slice, docs/word-count.md)', () => {
  it('counts the body: words, characters with and without spaces, non-empty paragraphs', () => {
    const r = countManuscript(doc(p('The well-known road—long, cold.'), p(), p('In 1902, 3 men.')))
    // The / well-known / road—long, / cold. + In / 1902, / 3 / men.
    expect(r.body).toEqual({ words: 8, charactersNoSpaces: 40, charactersWithSpaces: 46, paragraphs: 2 })
  })

  it('counts text as it reads with every tracked change accepted: insertions in, deletions out', () => {
    const r = countManuscript(doc(p('The ', text('old ', del), text('new ', ins), 'house')))
    expect(r.body.words).toBe(3)
    expect(r.body.charactersWithSpaces).toBe('The new house'.length)
  })

  it('a paragraph whose mark and text are deleted is gone; a deleted paragraph mark joins the paragraphs', () => {
    const deletedParagraph = { type: 'paragraph', attrs: { trackedDelete: change }, content: [text('All of this goes', del)] }
    expect(countManuscript(doc(p('One two'), deletedParagraph, p('three'))).body).toMatchObject({ words: 3, paragraphs: 2 })
    // "fo¶ar" with the ¶ deleted reads "foar": one word, one paragraph.
    const joined = { type: 'paragraph', attrs: { trackedDelete: change }, content: [text('ar')] }
    expect(countManuscript(doc(p('fo'), joined)).body).toMatchObject({ words: 1, paragraphs: 1 })
  })

  it('counts footnotes apart from the body: each note a paragraph of its own, its reference no character', () => {
    const r = countManuscript(doc(p('A road', fn('First told in 1902.'), '.'), p('Then', fn('Deleted note.', del), ' home')))
    expect(r.body).toMatchObject({ words: 4, charactersWithSpaces: 'A road.'.length + 'Then home'.length, paragraphs: 2 })
    expect(r.footnotes).toEqual({ words: 4, charactersNoSpaces: 16, charactersWithSpaces: 19, paragraphs: 1 })
  })

  it('breaks and empty paragraphs count nothing; hard breaks separate words', () => {
    const r = countManuscript(doc(p('a'), { type: 'sceneBreak' }, { type: 'pageBreak' }, p('b', { type: 'hardBreak' }, 'c')))
    expect(r.body).toEqual({ words: 3, charactersNoSpaces: 3, charactersWithSpaces: 3, paragraphs: 2 })
  })

  it('counts list paragraphs', () => {
    const list = { type: 'bulletList', content: [{ type: 'listItem', content: [p('one two')] }, { type: 'listItem', content: [p('three')] }] }
    expect(countManuscript(doc(p('x'), list)).body).toMatchObject({ words: 4, paragraphs: 3 })
  })

  it('per chapter from getChapters ranges, with the front matter apart; they add up to the book', () => {
    const d = doc(p('Title page'), h1('One'), p('a b c', fn('n1 n2')), h1('Two'), p('d e'))
    const r = countManuscript(d, getChapters(d, undefined, 'none'))
    expect(r.frontMatter.body.words).toBe(2)
    expect(r.chapters.map((c) => [c.title, c.body.words, c.footnotes.words])).toEqual([
      ['One', 4, 2],
      ['Two', 3, 0],
    ])
    const sum = r.chapters.reduce((s, c) => s + c.body.words, r.frontMatter.body.words)
    expect(sum).toBe(r.body.words)
  })
})

describe('selection counts', () => {
  it('counts the selected part of the text, and the footnotes referenced in it', () => {
    const d = doc(p('alpha beta gamma'), p('delta', fn('a note here'), ' epsilon'))
    // "beta gamma" … "delta": from inside the first paragraph to inside the second.
    const from = 1 + 'alpha '.length
    // Through the footnote reference (an inline atom: its open, its text, its close).
    const to = 1 + 'alpha beta gamma'.length + 2 + 'delta'.length + 'a note here'.length + 2
    const r = countRange(d, from, to)
    expect(r.body).toMatchObject({ words: 3, paragraphs: 2 })
    expect(r.footnotes.words).toBe(3)
  })

  it('a selection inside one word counts it as a word', () => {
    const d = doc(p('wonderful'))
    expect(countRange(d, 2, 5).body).toMatchObject({ words: 1, charactersNoSpaces: 3 })
  })
})

describe('incremental counting', () => {
  it('a keystroke recounts only the edited block (cached per top-level node)', () => {
    const blocks = Array.from({ length: 200 }, (_, i) => p(`Paragraph number ${i} has some words in it.`))
    const d = doc(...blocks)
    countManuscript(d)
    const before = wordCountRecounts()
    countManuscript(d)
    expect(wordCountRecounts() - before).toBe(0)
    // Type one character in paragraph 100.
    let pos = 0
    for (let i = 0; i < 100; i++) pos += d.child(i).nodeSize
    const edited = d.replace(pos + 2, pos + 2, new Slice(Fragment.from(schema.text('X')), 0, 0))
    const mid = wordCountRecounts()
    const r = countManuscript(edited)
    expect(wordCountRecounts() - mid).toBe(1)
    expect(r.body.words).toBe(200 * 8)
  })
})
