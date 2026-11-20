import type { Editor } from '@tiptap/core'
import { afterEach, describe, expect, it } from 'vitest'
import { createParagraphIndex, followEditor, highestParagraphId, type ParagraphIndex } from './paragraph-index'
import { blockPosOf, h1, makeEditor, p, t, textPosOf } from './test-doc'

let editor: Editor | null = null
afterEach(() => {
  editor?.destroy()
  editor = null
})

/** An editor whose transactions reach the index, as the agent loop wires it. */
function setup(...content: Parameters<typeof makeEditor>): { ed: Editor; idx: ParagraphIndex } {
  const ed = makeEditor(...content)
  editor = ed
  const idx = createParagraphIndex(ed)
  followEditor(idx)
  return { ed, idx }
}

const BOOK = [h1('One'), p(t('First paragraph.')), p(t('Second paragraph.')), h1('Two'), p(t('Third paragraph.'))]

describe('createParagraphIndex', () => {
  it('mints p1, p2… per session, one id per paragraph, the same id when asked again', () => {
    const { ed, idx } = setup(...BOOK)
    const a = idx.idFor(blockPosOf(ed, 'First'))
    const b = idx.idFor(textPosOf(ed, 'Second') + 3)
    expect([a, b]).toEqual(['p1', 'p2'])
    expect(idx.idFor(textPosOf(ed, 'First') + 5)).toBe('p1')
    const pos = blockPosOf(ed, 'Second')
    expect(idx.resolve('p2')).toEqual({ from: pos, to: pos + ed.state.doc.nodeAt(pos)!.nodeSize })
    expect(idx.resolve('p99')).toBe('unknown')
  })

  it('idsAfter: a session for a reopened chat mints above the old ids, so those stay unknown (final B-I2)', () => {
    const ed = makeEditor(...BOOK)
    editor = ed
    const idx = createParagraphIndex(ed, { idsAfter: 7 })
    expect(idx.idFor(blockPosOf(ed, 'First'))).toBe('p8')
    expect(idx.idFor(blockPosOf(ed, 'Second'))).toBe('p9')
    for (const old of ['p1', 'p2', 'p7']) expect(idx.resolve(old)).toBe('unknown')
  })

  it('highestParagraphId finds the largest id in text and tool results, ignoring other words', () => {
    expect(highestParagraphId('')).toBe(0)
    expect(highestParagraphId('[p3] a\n[p12 footnote 2] b')).toBe(12)
    expect(highestParagraphId(JSON.stringify({ paragraph: 'p41', note: 'top9 mp3 p5x' }))).toBe(41)
    expect(highestParagraphId('p1234567890123')).toBe(0)
  })

  it('carries a paragraph through an edit before it (the shifted range)', () => {
    const { ed, idx } = setup(...BOOK)
    const id = idx.idFor(blockPosOf(ed, 'Second'))
    const before = idx.resolve(id) as { from: number; to: number }
    ed.commands.insertContentAt(textPosOf(ed, 'First'), 'Very ')
    const after = idx.resolve(id)
    expect(after).toEqual({ from: before.from + 5, to: before.to + 5 })
    expect(ed.state.doc.textBetween((after as { from: number }).from, (after as { to: number }).to)).toBe('Second paragraph.')
    expect(idx.idFor(blockPosOf(ed, 'Second'))).toBe(id)
  })

  it("answers 'changed' after an edit inside the paragraph, and stays so", () => {
    const { ed, idx } = setup(...BOOK)
    const id = idx.idFor(blockPosOf(ed, 'Second'))
    ed.commands.insertContentAt(textPosOf(ed, 'Second') + 'Second '.length, 'new ')
    expect(idx.resolve(id)).toBe('changed')
    // The edited paragraph gets a fresh id; the old one never points anywhere again.
    expect(idx.idFor(blockPosOf(ed, 'Second'))).not.toBe(id)
    expect(idx.resolve(id)).toBe('changed')
  })

  it("answers 'changed' when the paragraph was deleted, and keeps neighbours", () => {
    const { ed, idx } = setup(...BOOK)
    const first = idx.idFor(blockPosOf(ed, 'First'))
    const second = idx.idFor(blockPosOf(ed, 'Second'))
    const third = idx.idFor(blockPosOf(ed, 'Third'))
    const pos = blockPosOf(ed, 'Second')
    ed.commands.deleteRange({ from: pos, to: pos + ed.state.doc.nodeAt(pos)!.nodeSize })
    expect(idx.resolve(second)).toBe('changed')
    expect(idx.resolve(first)).toEqual({ from: blockPosOf(ed, 'First'), to: expect.any(Number) })
    expect((idx.resolve(third) as { from: number }).from).toBe(blockPosOf(ed, 'Third'))
  })

  it("plays safe when edits were not mapped: every earlier id is 'changed'", () => {
    const ed = makeEditor(...BOOK)
    editor = ed
    const idx = createParagraphIndex(ed) // no transaction wiring
    const id = idx.idFor(blockPosOf(ed, 'Second'))
    ed.commands.insertContentAt(textPosOf(ed, 'First'), 'Very ')
    expect(idx.resolve(id)).toBe('changed')
  })

  it('locates a paragraph: 1-based chapter (as the navigation pane) and paragraph within it', () => {
    const { ed, idx } = setup(p(t('Dedication.')), ...BOOK)
    expect(idx.locationOf(idx.idFor(blockPosOf(ed, 'First')))).toEqual({ chapter: 1, paragraph: 1, line: null })
    expect(idx.locationOf(idx.idFor(blockPosOf(ed, 'Second')))).toEqual({ chapter: 1, paragraph: 2, line: null })
    expect(idx.locationOf(idx.idFor(blockPosOf(ed, 'Third')))).toEqual({ chapter: 2, paragraph: 1, line: null })
    // Front matter is chapter 0.
    expect(idx.locationOf(idx.idFor(blockPosOf(ed, 'Dedication')))).toEqual({ chapter: 0, paragraph: 1, line: null })
  })

  it('gives the layout line of a position when pagination has laid the book out', () => {
    const ed = makeEditor(...BOOK)
    editor = ed
    const calls: { from: number; to: number }[] = []
    const idx = createParagraphIndex(ed, {
      countLines: (r) => {
        calls.push(r)
        return 3
      },
    })
    const id = idx.idFor(blockPosOf(ed, 'Second'))
    const at = textPosOf(ed, 'Second') + 'Second '.length
    expect(idx.locationOf(id, at)).toEqual({ chapter: 1, paragraph: 2, line: 3 })
    expect(calls).toEqual([{ from: blockPosOf(ed, 'Second') + 1, to: at + 1 }])
  })
})
