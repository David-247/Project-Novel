import { getSchema, type JSONContent } from '@tiptap/core'
import { Node as PMNode } from '@tiptap/pm/model'
import { describe, expect, it } from 'vitest'
import { createEditorExtensions } from '@/features/editor'
import { blockCheckText, isContiguous, textRangeToDoc } from './block-text'

const schema = getSchema(createEditorExtensions())
const stamp = { id: 'c1', author: 'Ann', date: '2026-01-01T00:00:00.000Z', authorColor: null }
const t = (text: string, marks?: JSONContent['marks']): JSONContent => ({ type: 'text', text, ...(marks ? { marks } : {}) })
const del = [{ type: 'deletion', attrs: stamp }]
const ins = [{ type: 'insertion', attrs: { ...stamp, id: 'c2' } }]

/** A doc of one paragraph; returns the paragraph node and its position. */
function para(...content: JSONContent[]) {
  const doc = PMNode.fromJSON(schema, { type: 'doc', content: [{ type: 'paragraph', content }] })
  return { doc, block: doc.child(0), pos: 0 }
}

/** The document text a block-text range lands on. */
function docText(doc: PMNode, from: number, to: number) {
  return doc.textBetween(from, to, '', (n) => (n.type.name === 'footnote' ? '[fn]' : ''))
}

describe('blockCheckText (No Markup text and its positions)', () => {
  it('maps plain text one to one, after the block opening', () => {
    const { doc, block, pos } = para(t('I saw teh dog.'))
    const { text, segments } = blockCheckText(block, pos)
    expect(text).toBe('I saw teh dog.')
    const r = textRangeToDoc(segments, 6, 9)!
    expect(r).toEqual({ from: 7, to: 10 })
    expect(docText(doc, r.from, r.to)).toBe('teh')
  })

  it('counts curly quotes, accents and emoji in UTF-16 units, as ProseMirror does', () => {
    const { doc, block, pos } = para(t('“Aelinor’s” Zoë—said \u{1F600} teh'))
    const { text, segments } = blockCheckText(block, pos)
    const start = text.indexOf('teh')
    const r = textRangeToDoc(segments, start, start + 3)!
    expect(docText(doc, r.from, r.to)).toBe('teh')
  })

  it('leaves tracked deletions out and keeps insertions (No Markup), mapping across the gap', () => {
    const { doc, block, pos } = para(t('The '), t('big ', del), t('teh', ins), t(' dog'))
    const { text, segments } = blockCheckText(block, pos)
    expect(text).toBe('The teh dog')
    const r = textRangeToDoc(segments, 4, 7)!
    expect(docText(doc, r.from, r.to)).toBe('teh')
    // A range over the hidden text spans it in the document, and is not contiguous.
    const across = textRangeToDoc(segments, 0, 7)!
    expect(docText(doc, across.from, across.to)).toBe('The big teh')
    expect(isContiguous(segments, 0, 7)).toBe(false)
    expect(isContiguous(segments, 4, 7)).toBe(true)
  })

  it('leaves footnote references out (their note is not in the sentence)', () => {
    const { doc, block, pos } = para(t('A road'), { type: 'footnote', content: [t('Smith, 1999.')] }, t(' and teh end'))
    const { text, segments } = blockCheckText(block, pos)
    expect(text).toBe('A road and teh end')
    const start = text.indexOf('teh')
    const r = textRangeToDoc(segments, start, start + 3)!
    expect(docText(doc, r.from, r.to)).toBe('teh')
  })

  it('reads a hard break as a newline so the words around it stay apart', () => {
    const { doc, block, pos } = para(t('one'), { type: 'hardBreak' }, t('teh'))
    const { text, segments } = blockCheckText(block, pos)
    expect(text).toBe('one\nteh')
    const r = textRangeToDoc(segments, 4, 7)!
    expect(docText(doc, r.from, r.to)).toBe('teh')
  })

  it('an end at a gap stays before the hidden content', () => {
    const { doc, block, pos } = para(t('teh'), t('x', del), t(' more'))
    const { segments } = blockCheckText(block, pos)
    const r = textRangeToDoc(segments, 0, 3)!
    expect(docText(doc, r.from, r.to)).toBe('teh')
  })

  it('a fully deleted block reads as empty; out-of-range offsets do not map', () => {
    const doc = PMNode.fromJSON(schema, {
      type: 'doc',
      content: [{ type: 'paragraph', attrs: { trackedDelete: stamp }, content: [t('gone', del)] }],
    })
    expect(blockCheckText(doc.child(0), 0).text).toBe('')
    const { segments } = blockCheckText(para(t('abc')).block, 0)
    expect(textRangeToDoc(segments, 2, 9)).toBeNull()
    expect(textRangeToDoc(segments, 1, 1)).toBeNull()
  })
})
