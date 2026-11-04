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
