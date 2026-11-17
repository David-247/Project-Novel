import { Schema } from '@tiptap/pm/model'
import { EditorState } from '@tiptap/pm/state'
import { AddMarkStep } from '@tiptap/pm/transform'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { describe, expect, it } from 'vitest'
import { createPaginationPlugin, isBulk, markSpan, paginationKey } from './engine'

/** The decorations of a transaction with very many steps: dropped, unless the steps move nothing. */

const schema = new Schema({
  nodes: {
    doc: { content: 'paragraph+' },
    paragraph: { content: 'text*', attrs: { mark: { default: null }, rewriteId: { default: null } }, toDOM: () => ['p', 0] },
    text: {},
  },
  marks: { strong: { toDOM: () => ['strong', 0] } },
})

function setup(blocks: number, text = (i: number) => `Block ${i}.`) {
  const doc = schema.node('doc', null, Array.from({ length: blocks }, (_, i) => schema.node('paragraph', null, schema.text(text(i)))))
  let state = EditorState.create({ doc, plugins: [createPaginationPlugin({})] })
  const decos: Decoration[] = []
  state.doc.forEach((node, pos) => decos.push(Decoration.node(pos, pos + node.nodeSize, { class: 'shifted' })))
  state = state.apply(state.tr.setMeta(paginationKey, DecorationSet.create(state.doc, decos)))
  return state
}

describe('pagination decorations through a large transaction', () => {
  it('250 attribute steps (a re-write anchor on a chapter) keep the decorations mapped', () => {
    let state = setup(250)
    const tr = state.tr
    state.doc.forEach((_, pos) => void tr.setNodeAttribute(pos, 'mark', 'x'))
    expect(tr.steps).toHaveLength(250)
    state = state.apply(tr)
    const s = paginationKey.getState(state)!
    expect(s.unmapped).toBe(false)
    expect(s.set.find()).toHaveLength(250)
  })

  it('250 steps that move text drop them (the next pass redraws)', () => {
    let state = setup(250)
    const tr = state.tr
    state.doc.forEach((_, pos) => void tr.insertText('a', tr.mapping.map(pos) + 1))
    state = state.apply(tr)
    expect(paginationKey.getState(state)!.unmapped).toBe(true)
  })
})

/**
 * Mark-only bulk transactions (Select All + Bold, a tracked formatting change on every block): their
 * step maps are empty, so nothing trips the mapping limit; `bulk` routes the next pass onto the
 * progressive draw instead (review UI #1), while the drawn set stays mapped (no blank frame).
 */
describe('the bulk signal', () => {
  const long = (i: number) => `Block ${i}. ` + 'lorem ipsum dolor sit amet '.repeat(3)

  it('300 mark steps: bulk, decorations kept', () => {
    let state = setup(300)
    const tr = state.tr
    state.doc.forEach((node, pos) => void tr.addMark(pos + 1, pos + node.nodeSize - 1, schema.marks.strong.create()))
    expect(tr.steps).toHaveLength(300)
    state = state.apply(tr)
    const s = paginationKey.getState(state)!
    expect(s.bulk).toBe(true)
    expect(s.unmapped).toBe(false)
    expect(s.set.find()).toHaveLength(300)
  })

  it('one mark step over the whole book: bulk', () => {
    let state = setup(400, long)
    // One step (as Tiptap's setMark makes over a selection spanning the book), well under the step limit.
    const tr = state.tr.step(new AddMarkStep(0, state.doc.content.size, schema.marks.strong.create()))
    expect(tr.steps).toHaveLength(1)
    expect(markSpan(tr)).toBeGreaterThan(20_000)
    state = state.apply(tr)
    expect(paginationKey.getState(state)!.bulk).toBe(true)
    expect(paginationKey.getState(state)!.set.find()).toHaveLength(400)
  })

  it('typing and a small format change are not bulk; the next pass (meta) clears it', () => {
    let state = setup(400, long)
    state = state.apply(state.tr.insertText('a', 3))
    expect(paginationKey.getState(state)!.bulk).toBe(false)
    state = state.apply(state.tr.addMark(3, 200, schema.marks.strong.create()))
    expect(paginationKey.getState(state)!.bulk).toBe(false)
    state = state.apply(state.tr.addMark(0, state.doc.content.size, schema.marks.strong.create()))
    // Stays set through later small transactions until a pass draws.
    state = state.apply(state.tr.insertText('b', 3))
    expect(paginationKey.getState(state)!.bulk).toBe(true)
    state = state.apply(state.tr.setMeta(paginationKey, DecorationSet.empty))
    expect(paginationKey.getState(state)!.bulk).toBe(false)
  })

  it('attribute steps count the size of the node they change', () => {
    const state = setup(400, long)
    const tr = state.tr
    state.doc.forEach((_, pos) => void tr.setNodeAttribute(pos, 'mark', 'x'))
    expect(markSpan(tr)).toBe(state.doc.content.size)
    expect(isBulk(tr)).toBe(true)
  })

  it('the re-write anchor (rewriteId, not rendered) on a whole chapter is not bulk', () => {
    const state = setup(400, long)
    const tr = state.tr
    state.doc.forEach((_, pos) => void tr.setNodeAttribute(pos, 'rewriteId', 'rw1'))
    expect(markSpan(tr)).toBe(0)
    // 400 steps, but none that changes how a block looks.
    expect(isBulk(tr)).toBe(false)
  })
})
