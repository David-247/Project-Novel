import { describe, expect, it } from 'vitest'
import { getSchema } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import { createEditorExtensions } from '@/features/editor'
import { alignBlocks, blockText, diffPassages, similarity } from './align'
import { computePads } from './compare'

const schema = getSchema(createEditorExtensions({ detached: true }))
const p = (t: string) => ({ type: 'paragraph', content: t ? [{ type: 'text', text: t }] : undefined })
const doc = (...paras: string[]): PMNode => schema.nodeFromJSON({ type: 'doc', content: paras.map(p) })
/** Text of [from, to) in `d`. */
const slice = (d: PMNode, r: { from: number; to: number }) => d.textBetween(r.from, r.to)

describe('paragraph alignment', () => {
  it('pairs identical and edited paragraphs in order', () => {
    const a = doc('The rain came at dusk.', 'She closed the shutters.', 'Nobody spoke.')
    const b = doc('The rain came at dusk.', 'She slammed the shutters shut.', 'Nobody spoke.')
    expect(alignBlocks(a, b)).toEqual([
      { left: 0, right: 0, kind: 'same' },
      { left: 1, right: 1, kind: 'changed' },
      { left: 2, right: 2, kind: 'same' },
    ])
  })

  it('leaves a gap for an inserted paragraph instead of shifting the pairs', () => {
    const a = doc('One fish swam.', 'Two birds sang loudly.', 'Three cats slept.')
    const b = doc('One fish swam.', 'A wholly new paragraph appears here.', 'Two birds sang loudly.', 'Three cats slept.')
    expect(alignBlocks(a, b).map((r) => [r.left, r.right, r.kind])).toEqual([
      [0, 0, 'same'],
      [null, 1, 'added'],
      [1, 2, 'same'],
      [2, 3, 'same'],
    ])
  })

  it('leaves a gap for a removed paragraph', () => {
    const a = doc('Alpha beta gamma.', 'Delete me entirely please.', 'Omega psi chi.')
    const b = doc('Alpha beta gamma.', 'Omega psi chi.')
    expect(alignBlocks(a, b).map((r) => r.kind)).toEqual(['same', 'removed', 'same'])
  })

  it('does not pair paragraphs with nothing in common (removed, then added)', () => {
    const a = doc('Completely different words here.')
    const b = doc('Nothing alike at all.')
    expect(alignBlocks(a, b)).toEqual([
      { left: 0, right: null, kind: 'removed' },
      { left: null, right: 0, kind: 'added' },
    ])
  })

  it('pairs a split paragraph with its better half', () => {
    const a = doc('He ran to the door and opened it, and the wind came in.')
    const b = doc('He ran to the door and opened it.', 'The wind came in.')
    const rows = alignBlocks(a, b)
    expect(rows[0]).toEqual({ left: 0, right: 0, kind: 'changed' })
    expect(rows[1]).toEqual({ left: null, right: 1, kind: 'added' })
  })

  it('similarity is symmetric, 1 for equal text and 0 without common words', () => {
    const [x, y] = [doc('a b c d').child(0), doc('c d e f').child(0)]
    expect(similarity(x, y)).toBeCloseTo(0.5)
    expect(similarity(y, x)).toBeCloseTo(0.5)
    expect(similarity(x, x)).toBe(1)
    expect(similarity(x, doc('z').child(0))).toBe(0)
  })
})

describe('word diff', () => {
  it('maps removed and added words to document positions on each side', () => {
    const a = doc('She closed the shutters.')
    const b = doc('She slammed the heavy shutters.')
    const d = diffPassages(a, b)
    expect(d.removed.map((r) => slice(a, r))).toEqual(['closed'])
    expect(d.added.map((r) => slice(b, r))).toEqual(['slammed', 'heavy'])
  })

  it('marks whole unpaired blocks, and nothing for identical ones', () => {
    const a = doc('Same here.', 'Gone forever and ever.')
    const b = doc('Same here.', 'Brand new lines arrive.')
    const d = diffPassages(a, b)
    expect(d.removed).toEqual([])
    expect(d.added).toEqual([])
    expect(d.removedBlocks).toEqual([a.child(0).nodeSize])
    expect(d.addedBlocks).toEqual([b.child(0).nodeSize])
  })

  it('counts a footnote reference as one unit of text', () => {
    const fn = { type: 'footnote', content: [{ type: 'text', text: 'note' }] }
    const a = schema.nodeFromJSON({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Old word' }, fn, { type: 'text', text: ' end.' }] }] })
    const b = schema.nodeFromJSON({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'New word' }, fn, { type: 'text', text: ' end.' }] }] })
    expect(blockText(a.child(0)).text).toBe('Old word￼ end.')
    const d = diffPassages(a, b)
    expect(d.removed.map((r) => slice(a, r))).toEqual(['Old'])
    expect(d.added.map((r) => slice(b, r))).toEqual(['New'])
  })
})

describe('alignment pads', () => {
  it('pads the higher side of each pair so paired rows start level', () => {
    // Left: blocks at 0, 20, 40. Right: an inserted block makes its 2nd and 3rd blocks 30 px lower.
    const rows = [
      { left: 0, right: 0, kind: 'same' as const },
      { left: null, right: 1, kind: 'added' as const },
      { left: 1, right: 2, kind: 'same' as const },
      { left: 2, right: 3, kind: 'changed' as const },
    ]
    const { left, right, stitches } = computePads(rows, [0, 20, 40], [0, 20, 50, 70])
    expect(left).toEqual([0, 30, 0])
    expect(right).toEqual([0, 0, 0, 0])
    expect(stitches.map((s) => s.top)).toEqual([0, 20, 50, 70])
  })

  it('pads the right side when the original is taller', () => {
    const rows = [
      { left: 0, right: 0, kind: 'changed' as const },
      { left: 1, right: 1, kind: 'same' as const },
    ]
    const { left, right } = computePads(rows, [0, 60], [0, 20])
    expect(left).toEqual([0, 0])
    expect(right).toEqual([0, 40])
  })
})
