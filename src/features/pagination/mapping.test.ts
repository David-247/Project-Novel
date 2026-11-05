import { Schema } from '@tiptap/pm/model'
import { EditorState } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { describe, expect, it } from 'vitest'
import { createPaginationPlugin, paginationKey } from './engine'

/** The decorations of a transaction with very many steps: dropped, unless the steps move nothing. */

const schema = new Schema({
  nodes: {
    doc: { content: 'paragraph+' },
    paragraph: { content: 'text*', attrs: { mark: { default: null } }, toDOM: () => ['p', 0] },
    text: {},
  },
})

function setup(blocks: number) {
  const doc = schema.node('doc', null, Array.from({ length: blocks }, (_, i) => schema.node('paragraph', null, schema.text(`Block ${i}.`))))
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
