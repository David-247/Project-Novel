import { Editor, getSchema, type JSONContent } from '@tiptap/core'
import { Fragment, Slice, type Node as PMNode } from '@tiptap/pm/model'
import { EditorState } from '@tiptap/pm/state'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createEditorExtensions } from '@/features/editor'
import { useStore } from '@/shared/store'
import { isBlockHidden, isInlineHidden, MARKUP_VIEW_META, type MarkupView } from '@/shared/track-changes'
import { copiedSlice } from './copy'
import { changedBlockPositions, setMarkupViewRepaginate } from './extension'
import {
  acceptAll,
  acceptChange,
  acceptChangesInRange,
  countChanges,
  listChanges,
  rejectAll,
  rejectChange,
  rejectChangesInRange,
} from './review'

/** Accept / reject core and what each markup view hides. Pure: states built from JSON. */

const schema = getSchema(createEditorExtensions())
beforeAll(() => {
  const emptyRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList
  Range.prototype.getClientRects ??= emptyRects
  Element.prototype.getClientRects ??= emptyRects
})
afterEach(() => useStore.getState().trackChangesActions.setMarkupView('all'))

const t = (text: string, marks?: JSONContent['marks']): JSONContent => ({ type: 'text', text, ...(marks ? { marks } : {}) })
const ins = (id: string, author = 'Ann') => ({ type: 'insertion', attrs: { id, author, date: '2026-01-01T00:00:00.000Z' } })
const del = (id: string, author = 'Ann') => ({ type: 'deletion', attrs: { id, author, date: '2026-01-01T00:00:00.000Z' } })
const stamp = (id: string) => ({ id, author: 'Ann', date: '2026-01-01T00:00:00.000Z' })
const p = (content: JSONContent[], attrs?: Record<string, unknown>): JSONContent => ({ type: 'paragraph', ...(attrs ? { attrs } : {}), content })

function state(content: JSONContent[]): EditorState {
  return EditorState.create({ schema, doc: schema.nodeFromJSON({ type: 'doc', content }), plugins: [] })
}
const apply = (s: EditorState, tr: ReturnType<typeof acceptAll>) => (tr ? s.apply(tr) : s)
const texts = (doc: PMNode) => {
  const out: string[] = []
  doc.forEach((b) => out.push(b.isLeaf ? `[${b.type.name}]` : b.textContent))
  return out
}
const hasTracking = (doc: PMNode) => listChanges(doc).length > 0

/**
 * A manuscript with every kind of change: inserted / deleted text, an inserted paragraph, a deleted
 * paragraph, a pending paragraph join, an inserted page break, a format change and a style change.
 */
const sample = (): JSONContent[] => [
  p([t('Keep '), t('old', [del('d1')]), t('new', [ins('i1')]), t(' end.')]),
  p([t('Inserted paragraph.', [ins('i2')])], { trackedInsert: stamp('i2') }),
  p([t('Deleted paragraph.', [del('d2')])], { trackedDelete: stamp('d2') }),
  p([t('Joined tail.')], { trackedDelete: stamp('d3') }),
  { type: 'pageBreak', attrs: { trackedInsert: stamp('i3') } },
  p([t('Bold', [{ type: 'bold' }, { type: 'formatChange', attrs: { ...stamp('f1'), before: [] } }]), t(' text.')]),
  {
    type: 'heading',
    attrs: { level: 1, trackedStyleChange: { ...stamp('s1'), beforeStyleId: null, beforeType: 'paragraph', beforeAttrs: { styleId: null } } },
    content: [t('Was a paragraph')],
  },
]

describe('listChanges / countChanges', () => {
  it('lists each change once, with its kinds, author and range', () => {
    const s = state(sample())
    const changes = listChanges(s.doc)
    expect(changes.map((c) => c.id)).toEqual(['d1', 'i1', 'i2', 'd2', 'd3', 'i3', 'f1', 's1'])
    expect(changes.find((c) => c.id === 'i2')!.kinds.sort()).toEqual(['blockInsert', 'insertion'])
    expect(countChanges(s)).toBe(8)
  })
})

describe('acceptAll / rejectAll', () => {
  it('accept all: insertions stay, deletions go, pending joins join, formatting stays', () => {
    const s = apply(state(sample()), acceptAll(state(sample())))
    expect(texts(s.doc)).toEqual(['Keep new end.', 'Inserted paragraph.Joined tail.', '[pageBreak]', 'Bold text.', 'Was a paragraph'])
    expect(s.doc.child(4).type.name).toBe('heading')
    expect(s.doc.child(3).firstChild!.marks.map((m) => m.type.name)).toEqual(['bold'])
    expect(hasTracking(s.doc)).toBe(false)
  })

  it('reject all: insertions go, deletions stay, formatting and styles are restored', () => {
    const s = apply(state(sample()), rejectAll(state(sample())))
    expect(texts(s.doc)).toEqual(['Keep old end.', 'Deleted paragraph.', 'Joined tail.', 'Bold text.', 'Was a paragraph'])
    expect(s.doc.child(3).firstChild!.marks).toHaveLength(0)
    expect(s.doc.child(4).type.name).toBe('paragraph')
    expect(hasTracking(s.doc)).toBe(false)
  })

  it('nothing to do: null', () => {
    const s = state([p([t('plain')])])
    expect(acceptAll(s)).toBeNull()
    expect(rejectAll(s)).toBeNull()
  })
})

describe('single changes and ranges', () => {
  it('accept / reject one change by id leaves the others', () => {
    const s0 = state(sample())
    const a = apply(s0, acceptChange(s0, 'd1'))
    expect(a.doc.child(0).textContent).toBe('Keep new end.')
    expect(listChanges(a.doc).map((c) => c.id)).not.toContain('d1')
    expect(listChanges(a.doc)).toHaveLength(7)
    const r = apply(s0, rejectChange(s0, 'i1'))
    expect(r.doc.child(0).textContent).toBe('Keep old end.')
    const joined = apply(s0, rejectChange(s0, 'd3'))
    expect(joined.doc.child(3).attrs.trackedDelete).toBeNull()
  })

  it('reject an inserted paragraph removes it; reject a deleted join keeps the split', () => {
    const s0 = state(sample())
    const r = apply(s0, rejectChange(s0, 'i2'))
    expect(texts(r.doc).slice(0, 2)).toEqual(['Keep oldnew end.', 'Deleted paragraph.'])
  })

  it('range variants act on the changes touching the range', () => {
    const s0 = state(sample())
    const first = s0.doc.child(0)
    const a = apply(s0, acceptChangesInRange(s0, 0, first.nodeSize))
    expect(a.doc.child(0).textContent).toBe('Keep new end.')
    expect(listChanges(a.doc)).toHaveLength(6)
    const r = apply(s0, rejectChangesInRange(s0, 0, first.nodeSize))
    expect(r.doc.child(0).textContent).toBe('Keep old end.')
  })
})

describe('markup views: hidden text', () => {
  const doc = state(sample()).doc
  const views: MarkupView[] = ['all', 'simple', 'none', 'original']
  /** The text a view shows, block by block (hidden blocks left out). */
  function shown(view: MarkupView): string[] {
    const out: string[] = []
    doc.forEach((b) => {
      if (isBlockHidden(b, view)) return
      let s = b.isLeaf ? `[${b.type.name}]` : ''
      b.forEach((c) => (s += isInlineHidden(c, view) ? '' : (c.text ?? '')))
      out.push(s)
    })
    return out
  }

  it('All Markup shows everything', () => {
    expect(shown('all')).toEqual(['Keep oldnew end.', 'Inserted paragraph.', 'Deleted paragraph.', 'Joined tail.', '[pageBreak]', 'Bold text.', 'Was a paragraph'])
  })

  it('Simple and No Markup show the final text (deleted paragraph gone)', () => {
    for (const v of ['simple', 'none'] as const)
      expect(shown(v)).toEqual(['Keep new end.', 'Inserted paragraph.', 'Joined tail.', '[pageBreak]', 'Bold text.', 'Was a paragraph'])
  })

  it('Original shows the text before the changes (inserted paragraph and break gone)', () => {
    expect(shown('original')).toEqual(['Keep old end.', 'Deleted paragraph.', 'Joined tail.', 'Bold text.', 'Was a paragraph'])
  })

  it('hidden blocks equal what accept all / reject all leave (block count, apart from pending joins)', () => {
    const accepted = apply(state(sample()), acceptAll(state(sample()))).doc
    const rejected = apply(state(sample()), rejectAll(state(sample()))).doc
    // A pending join (d3) is shown as two paragraphs until it is accepted: documented limitation.
    expect(shown('none').length - 1).toBe(accepted.childCount)
    expect(shown('original').length).toBe(rejected.childCount)
    for (const v of views) expect(shown(v).length).toBeGreaterThan(0)
  })

})

describe('a formatChange from a newer build', () => {
  it('reject drops the mark types this schema does not know instead of throwing', () => {
    const fc = { type: 'formatChange', attrs: { ...stamp('f1'), before: [{ type: 'italic' }, { type: 'sparkle', attrs: { level: 2 } }] } }
    const s = state([p([t('Bold', [{ type: 'bold' }, fc])])])
    const out = apply(s, rejectAll(s))
    expect(out.doc.firstChild!.firstChild!.marks.map((m) => m.type.name)).toEqual(['italic'])
    expect(hasTracking(out.doc)).toBe(false)
  })
})

describe('markup view switch', () => {
  it('decorates hidden blocks, sets <html data-nv-markup>, recomputes and asks for repagination', () => {
    const el = document.createElement('div')
    const ed = new Editor({ element: el, extensions: createEditorExtensions(), content: { type: 'doc', content: sample() } })
    const calls: number[][] = []
    const off = setMarkupViewRepaginate((positions) => calls.push(positions))
    const metas: unknown[] = []
    ed.on('transaction', ({ transaction }) => metas.push(transaction.getMeta(MARKUP_VIEW_META)))
    try {
      const blocks = Array.from(ed.view.dom.children)
      expect(blocks[2].classList.contains('nv-tc-gone-final')).toBe(true) // deleted paragraph
      expect(blocks[1].classList.contains('nv-tc-gone-original')).toBe(true) // inserted paragraph
      expect(blocks[4].classList.contains('nv-tc-gone-original')).toBe(true) // inserted page break
      expect(blocks[3].classList.contains('nv-tc-gone-final')).toBe(false) // pending join: text stays
      expect(blocks[0].classList.contains('nv-tc-has-del')).toBe(true)
      expect(ed.view.dom.querySelector('.nv-del')?.textContent).toBe('old')
      expect(ed.view.dom.querySelector('.nv-ins')?.textContent).toBe('new')

      useStore.getState().trackChangesActions.setMarkupView('none')
      expect(document.documentElement.dataset.nvMarkup).toBe('none')
      expect(metas).toContain('none')
      const positions: number[] = []
      ed.state.doc.forEach((_n, pos) => positions.push(pos))
      expect(calls).toEqual([positions]) // every block of the sample holds a change
      expect(changedBlockPositions(state([p([t('plain')])]).doc)).toEqual([])
    } finally {
      off()
      ed.destroy()
    }
  })
})

describe('hidden list items and lists', () => {
  const li = (...content: JSONContent[]): JSONContent => ({ type: 'listItem', content })
  const ul = (...items: JSONContent[]): JSONContent => ({ type: 'bulletList', content: items })
  const gone = (el: Element | null | undefined, cls: string) => !!el && el.classList.contains(cls)

  it('a list item whose paragraphs are all hidden is hidden too (no bullet left), and a list whose items all are', () => {
    const el = document.createElement('div')
    const ed = new Editor({
      element: el,
      extensions: createEditorExtensions(),
      content: {
        type: 'doc',
        content: [
          p([t('Intro')]),
          ul(li(p([t('Kept')])), li(p([t('Gone', [del('d1')])], { trackedDelete: stamp('d1') })), li(p([t('New', [ins('i1')])], { trackedInsert: stamp('i1') }))),
          ul(li(p([t('All new', [ins('i2')])], { trackedInsert: stamp('i2') }))),
        ],
      },
    })
    try {
      const items = () => Array.from(ed.view.dom.querySelectorAll('li'))
      expect(gone(items()[0], 'nv-tc-gone-final')).toBe(false)
      expect(gone(items()[1], 'nv-tc-gone-final')).toBe(true)
      expect(gone(items()[2], 'nv-tc-gone-original')).toBe(true)
      const lists = () => Array.from(ed.view.dom.querySelectorAll('ul'))
      expect(gone(lists()[0], 'nv-tc-gone-final')).toBe(false)
      expect(gone(lists()[1], 'nv-tc-gone-original')).toBe(true)
      // Incremental: accepting the deletion in the list item removes it, rejecting the new list removes that.
      ed.view.dispatch(acceptAll(ed.state)!)
      expect(items().map((x) => x.textContent)).toEqual(['Kept', 'New', 'All new'])
      expect(items().some((x) => gone(x, 'nv-tc-gone-final') || gone(x, 'nv-tc-gone-original'))).toBe(false)
      // A typed edit inside an item updates the item's class (the item is no longer all inserted).
      const s2 = state([ul(li(p([t('New', [ins('i3')])], { trackedInsert: stamp('i3') })))])
      ed.view.updateState(EditorState.create({ schema: ed.schema, doc: s2.doc, plugins: ed.state.plugins }))
      expect(gone(items()[0], 'nv-tc-gone-original')).toBe(true)
      ed.view.dispatch(ed.state.tr.insertText('x', 3).setMeta('nvTrackChangesSkip', true))
      expect(gone(items()[0], 'nv-tc-gone-original')).toBe(false)
      expect(gone(lists()[0], 'nv-tc-gone-original')).toBe(false)
    } finally {
      ed.destroy()
    }
  })
})

describe('copy', () => {
  const s = state(sample())
  const slice = s.doc.slice(0, s.doc.child(0).nodeSize + s.doc.child(1).nodeSize + s.doc.child(2).nodeSize)
  const textOf = (sl: Slice) => sl.content.textBetween(0, sl.content.size, '\n')

  it('copies the final text, without tracking marks, from All and No Markup', () => {
    for (const v of ['all', 'none'] as const) {
      const out = copiedSlice(slice, v)
      expect(textOf(out)).toBe('Keep new end.\nInserted paragraph.\n')
      let marks = 0
      out.content.descendants((n) => {
        marks += n.marks.filter((m) => ['insertion', 'deletion', 'formatChange'].includes(m.type.name)).length
        if (n.attrs.trackedInsert || n.attrs.trackedDelete) marks++
      })
      expect(marks).toBe(0)
    }
  })

  it('copies the original text from Original', () => {
    expect(textOf(copiedSlice(slice, 'original'))).toBe('Keep old end.\n\nDeleted paragraph.')
  })

  it('a slice without changes is returned as it is', () => {
    const plain = new Slice(Fragment.from(schema.text('x')), 0, 0)
    expect(copiedSlice(plain, 'all')).toBe(plain)
  })
})

describe('undo of a resolve never touches the paragraphs it skipped (re-review A)', () => {
  /** Apply `tr`, then its inverse (what undo does), and return the state after the undo. */
  function undone(s: EditorState, tr: NonNullable<ReturnType<typeof acceptAll>>): EditorState {
    let out = s.apply(tr)
    const inv = out.tr
    for (let i = tr.steps.length - 1; i >= 0; i--) inv.step(tr.steps[i].invert(tr.docs[i]))
    out = out.apply(inv)
    return out
  }
  /** The mark steps of `tr` that reach into top-level block `block` of `doc`. */
  const stepsOverBlock = (doc: PMNode, tr: NonNullable<ReturnType<typeof acceptAll>>, block: number) => {
    let from = 0
    for (let i = 0; i < block; i++) from += doc.child(i).nodeSize
    const to = from + doc.child(block).nodeSize
    return tr.steps
      .map((st) => st.toJSON() as { stepType: string; from: number; to: number })
      .filter((j) => j.stepType.endsWith('Mark') && j.from < to - 1 && j.to > from + 1)
  }
  const marksOf = (doc: PMNode, block: number) => {
    const out: string[][] = []
    doc.child(block).forEach((n) => out.push(n.marks.map((m) => m.type.name).sort()))
    return out
  }

  it('an insertion with a shared id around an unchanged paragraph (re-write Keep): undo gives P2 no mark', () => {
    const s = state([p([t('One.', [ins('k')])]), p([t('Unchanged.')]), p([t('Three.', [ins('k')])])])
    const tr = acceptAll(s)!
    expect(stepsOverBlock(s.doc, tr, 1)).toEqual([])
    expect(s.apply(tr).doc.child(1)).toBe(s.doc.child(1)) // untouched: the same node
    expect(marksOf(s.apply(tr).doc, 1)).toEqual([[]])
    const back = undone(s, tr)
    expect(back.doc.eq(s.doc)).toBe(true)
    expect(marksOf(back.doc, 1)).toEqual([[]])
  })

  it('a format change around a paragraph that was already bold: undo gives P2 no formatChange', () => {
    const fc = { type: 'formatChange', attrs: { ...stamp('f'), before: [] } }
    const s = state([p([t('One.', [{ type: 'bold' }, fc])]), p([t('Bold already.', [{ type: 'bold' }])]), p([t('Three.', [{ type: 'bold' }, fc])])])
    const tr = acceptAll(s)!
    expect(stepsOverBlock(s.doc, tr, 1)).toEqual([])
    const back = undone(s, tr)
    expect(back.doc.eq(s.doc)).toBe(true)
    expect(marksOf(back.doc, 1)).toEqual([['bold']])
  })
})
