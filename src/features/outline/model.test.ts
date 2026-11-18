import { getSchema, type JSONContent } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import { describe, expect, it } from 'vitest'
import { countManuscript, createEditorExtensions, getChapters, getResolvedStyles } from '@/features/editor'
import type { PageInfo, RootState } from '@/shared/store'
import { ZERO_COUNTS } from '@/shared/text'
import { countOutline } from './counts'
import { buildOutline, entryAt, pageRange, pageRangeText } from './model'

const schema = getSchema(createEditorExtensions())
const doc = (...content: JSONContent[]): PMNode => schema.nodeFromJSON({ type: 'doc', content })
const text = (t: string, marks?: JSONContent['marks']): JSONContent => ({ type: 'text', text: t, ...(marks ? { marks } : {}) })
const p = (t: string): JSONContent => ({ type: 'paragraph', content: [text(t)] })
const h = (level: 1 | 2, t?: string, extra: Record<string, unknown> = {}): JSONContent => ({ type: 'heading', attrs: { level, ...extra }, ...(t ? { content: [text(t)] } : {}) })
const change = { id: 'c1', author: 'Ann', date: '2026-01-01' }

const book = () =>
  doc(
    p('Dedication words here'), // front matter: 3 words
    h(1, 'The Storm'),
    p('One two three'),
    h(2, 'At sea'),
    p('Four five'),
    h(2, 'Ashore'),
    p('Six'),
    h(1), // an untitled chapter
    p('Seven eight'),
  )

describe('outline model', () => {
  it('lists Front matter, the chapters (number and title, or Untitled chapter N) and their subheadings nested', () => {
    const o = buildOutline(book(), getResolvedStyles(), 'all')
    expect(o.entries.map((e) => [e.kind, e.label, e.number])).toEqual([
      ['front', 'Front matter', null],
      ['chapter', 'The Storm', 1],
      ['chapter', 'Untitled chapter 2', 2],
    ])
    expect(o.entries[1].children.map((c) => [c.kind, c.label, c.level])).toEqual([
      ['subheading', 'At sea', 2],
      ['subheading', 'Ashore', 2],
    ])
    // Ranges tile the document: a chapter's covers its subheadings, a subheading runs to the next one.
    const [front, storm, untitled] = o.entries
    expect(front.from).toBe(0)
    expect(front.to).toBe(storm.from)
    expect(storm.to).toBe(untitled.from)
    expect(storm.children[0].to).toBe(storm.children[1].from)
    expect(storm.children[1].to).toBe(storm.to)
    expect(untitled.to).toBe(book().content.size)
    expect(o.flat).toHaveLength(5)
  })

  it('has no Front matter entry when the book opens with a chapter; with no chapter all of it is front matter', () => {
    expect(buildOutline(doc(h(1, 'One'), p('a b')), getResolvedStyles(), 'all').entries.map((e) => e.kind)).toEqual(['chapter'])
    const none = buildOutline(doc(p('a b'), h(2, 'Sub')), getResolvedStyles(), 'all')
    expect(none.entries.map((e) => e.kind)).toEqual(['front'])
    expect(none.entries[0].children.map((c) => c.label)).toEqual(['Sub'])
  })

  it('follows getChapters, so the markup view: a title inserted with tracking opens no chapter in Original', () => {
    const d = doc(h(1, 'One'), p('a'), { type: 'heading', attrs: { level: 1, trackedInsert: change }, content: [text('Two', [{ type: 'insertion', attrs: change }])] }, p('b'))
    expect(buildOutline(d, getResolvedStyles(), 'all').entries.map((e) => e.label)).toEqual(['One', 'Two'])
    expect(buildOutline(d, getResolvedStyles(), 'original').entries.map((e) => e.label)).toEqual(['One'])
    expect(buildOutline(d, getResolvedStyles(), 'original').chapters).toEqual(getChapters(d, getResolvedStyles(), 'original'))
  })

  it('is cached per document, style sheet and markup view (getChapters runs once per version)', () => {
    const d = book()
    const styles = getResolvedStyles()
    const a = buildOutline(d, styles, 'all')
    expect(buildOutline(d, styles, 'all')).toBe(a)
    expect(buildOutline(d, styles, 'none')).not.toBe(a)
    expect(buildOutline(book(), styles, 'all')).not.toBe(a)
  })

  it('entryAt: the deepest entry holding a position (the end of the book belongs to the last one)', () => {
    const d = book()
    const o = buildOutline(d, getResolvedStyles(), 'all')
    const [front, storm, untitled] = o.entries
    expect(entryAt(o, 0)?.key).toBe(front.key)
    expect(entryAt(o, storm.from + 1)?.key).toBe(storm.key)
    expect(entryAt(o, storm.children[0].from + 2)?.key).toBe(storm.children[0].key)
    expect(entryAt(o, storm.children[1].to - 1)?.key).toBe(storm.children[1].key)
    expect(entryAt(o, d.content.size)?.key).toBe(untitled.key)
  })
})

const page = (index: number, from: number, to: number, isBlank = false): PageInfo => ({ index, side: index % 2 ? 'verso' : 'recto', from, to, isBlank, startsBlockType: null, chapterIndex: 0 })

describe('page ranges', () => {
  const pages = [page(0, 0, 100), page(1, 100, 250), page(2, 250, 250, true), page(3, 250, 400), page(4, 400, 420)]
  it('the pages a range is laid out on, blank pages skipped', () => {
    expect(pageRange(pages, 0, 100)).toEqual({ first: 0, last: 0 })
    expect(pageRange(pages, 50, 260)).toEqual({ first: 0, last: 3 })
    // A chapter opening on a recto after a blank verso starts on the recto.
    expect(pageRange(pages, 250, 420)).toEqual({ first: 3, last: 4 })
    expect(pageRange(pages, 100, 250)).toEqual({ first: 1, last: 1 })
    expect(pageRange([], 0, 10)).toBeNull()
    expect(pageRange(pages, 10, 10)).toBeNull()
  })
  it('reads as Word numbers pages: "p. 12" or "pp. 12–19"', () => {
    expect(pageRangeText({ first: 11, last: 11 })).toBe('p. 12')
    expect(pageRangeText({ first: 11, last: 18 })).toBe('pp. 12–19')
    expect(pageRangeText(null)).toBe('')
  })
})

type WC = RootState['wordCount']
const notes = (words: number) => ({ body: { ...ZERO_COUNTS, words }, footnotes: { ...ZERO_COUNTS }, total: { ...ZERO_COUNTS, words } })

describe('outline counts', () => {
  const d = book()
  const o = buildOutline(d, getResolvedStyles(), 'all')
  const counted = countManuscript(d, getChapters(d, getResolvedStyles(), 'none'))
  const published = (over: Partial<WC> = {}): WC => ({
    ready: true,
    includeFootnotes: true,
    document: notes(counted.body.words),
    selection: null,
    frontMatter: notes(counted.frontMatter.body.words),
    chapters: counted.chapters.map((c) => ({ index: c.index, title: c.title, from: c.from, to: c.to, counts: notes(c.body.words) })),
    docVersion: 7,
    ...over,
  })

  it('words per entry: a chapter counts its subheadings too; the counts add up to the book', () => {
    const w = countOutline(d, o, published(), 7)
    const [front, storm, untitled] = o.entries
    expect(w.get(front.key)).toBe(3)
    // The Storm + One two three + At sea + Four five + Ashore + Six
    expect(w.get(storm.key)).toBe(2 + 3 + 2 + 2 + 1 + 1)
    expect(w.get(storm.children[0].key)).toBe(4)
    expect(w.get(storm.children[1].key)).toBe(2)
    expect(w.get(untitled.key)).toBe(2)
    expect(w.get(front.key)! + w.get(storm.key)! + w.get(untitled.key)!).toBe(counted.body.words)
  })

  it('chapters take the published counts when they are for this version, else count the range', () => {
    const [, storm] = o.entries
    const marked = published({ chapters: published().chapters.map((c) => ({ ...c, counts: notes(c.index === 0 ? 999 : 1) })) })
    expect(countOutline(d, o, marked, 7).get(storm.key)).toBe(999)
    // A stale publish (an older version) is not used.
    expect(countOutline(d, o, marked, 8).get(storm.key)).toBe(11)
    expect(countOutline(d, o, { ...marked, ready: false }, 7).get(storm.key)).toBe(11)
  })
})
