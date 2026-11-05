import { Editor, getSchema, type JSONContent } from '@tiptap/core'
import { undo } from '@tiptap/pm/history'
import type { Node as PMNode } from '@tiptap/pm/model'
import { EditorState, NodeSelection, TextSelection } from '@tiptap/pm/state'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createEditorExtensions } from '@/features/editor'
import { __resetCommandsForTests, getCommand, getCommands, runCommand } from '@/shared/commands'
import { useStore } from '@/shared/store'
import { byAuthorCommandId, registerTrackChangesCommands } from './menu-commands'
import { changeAtClick, describeChange, relativeDate, showChangeAtCaret } from './popover-actions'
import {
  acceptAll,
  acceptAllByAuthor,
  acceptChange,
  acceptChangesInRange,
  rejectChangesInRange,
  changeIdAt,
  listAuthors,
  listChanges,
  rejectAll,
  rejectAllByAuthor,
  rejectChange,
} from './review'
import {
  __resetReviewActionsForTests,
  CONFIRM_ABOVE,
  nextChange,
  prevChange,
  resolveAll,
  resolveAndNext,
  resolveSelection,
  setReviewConfirm,
} from './review-actions'
import { __resetReviewStateForTests, getChangePopover, getChangeSummary, getReviewView, refreshChangeSummary, setReviewViewSource } from './review-state'
import { TrackChanges } from './extension'
import { ChangePopover, ChangesIndicator } from './ReviewUI'

/**
 * Review (T7): accept / reject semantics for every kind of change (nested, adjacent, blocks,
 * footnotes, breaks, by author), the review commands on a live editor (one undo step each, nothing
 * recorded while tracking), Next / Previous Change, the confirmation above 50 changes, the change
 * popover and the status-bar count.
 */

const schema = getSchema(createEditorExtensions())
beforeAll(() => {
  const emptyRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList
  Range.prototype.getClientRects ??= emptyRects
  Range.prototype.getBoundingClientRect ??= () => ({ top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
  Element.prototype.getClientRects ??= emptyRects
  document.elementFromPoint ??= () => null
})

const DATE = '2026-01-01T00:00:00.000Z'
const t = (text: string, marks?: JSONContent['marks']): JSONContent => ({ type: 'text', text, ...(marks ? { marks } : {}) })
const ins = (id: string, author = 'Ann') => ({ type: 'insertion', attrs: { id, author, date: DATE } })
const del = (id: string, author = 'Ann') => ({ type: 'deletion', attrs: { id, author, date: DATE } })
const fmt = (id: string, before: unknown[] = [], author = 'Ann') => ({ type: 'formatChange', attrs: { id, author, date: DATE, before } })
const stamp = (id: string, author = 'Ann') => ({ id, author, date: DATE })
const p = (content: JSONContent[], attrs?: Record<string, unknown>): JSONContent => ({ type: 'paragraph', ...(attrs ? { attrs } : {}), content })
const fn = (text: string, marks?: JSONContent['marks']): JSONContent => ({ type: 'footnote', content: [t(text)], ...(marks ? { marks } : {}) })

const state = (content: JSONContent[]) => EditorState.create({ schema, doc: schema.nodeFromJSON({ type: 'doc', content }), plugins: [] })
const apply = (s: EditorState, tr: ReturnType<typeof acceptAll>) => (tr ? s.apply(tr) : s)
const texts = (doc: PMNode) => {
  const out: string[] = []
  doc.forEach((b) => out.push(b.isLeaf ? `[${b.type.name}]` : b.textContent))
  return out
}
const ids = (doc: PMNode) => listChanges(doc).map((c) => c.id)
const footnotes = (doc: PMNode) => {
  const out: string[] = []
  doc.descendants((n) => {
    if (n.type.name === 'footnote') out.push(n.textContent)
    return true
  })
  return out
}

describe('semantics', () => {
  it('insertion: accept keeps the text (mark gone); reject removes it', () => {
    const s = state([p([t('a '), t('new', [ins('i')]), t(' b')])])
    expect(texts(apply(s, acceptChange(s, 'i')).doc)).toEqual(['a new b'])
    expect(ids(apply(s, acceptChange(s, 'i')).doc)).toEqual([])
    expect(texts(apply(s, rejectChange(s, 'i')).doc)).toEqual(['a  b'])
  })

  it('deletion: accept removes the text; reject keeps it (mark gone)', () => {
    const s = state([p([t('a '), t('old', [del('d')]), t(' b')])])
    expect(texts(apply(s, acceptChange(s, 'd')).doc)).toEqual(['a  b'])
    const r = apply(s, rejectChange(s, 'd'))
    expect(texts(r.doc)).toEqual(['a old b'])
    expect(ids(r.doc)).toEqual([])
  })

  it('format change: accept keeps the new formatting; reject restores `before`', () => {
    const s = state([p([t('word', [{ type: 'bold' }, fmt('f', [{ type: 'italic' }])])])])
    const a = apply(s, acceptChange(s, 'f'))
    expect(a.doc.firstChild!.firstChild!.marks.map((m) => m.type.name)).toEqual(['bold'])
    const r = apply(s, rejectChange(s, 'f'))
    expect(r.doc.firstChild!.firstChild!.marks.map((m) => m.type.name)).toEqual(['italic'])
  })

  it('paragraph split: accept keeps two paragraphs; reject joins them back (one unit)', () => {
    const s = state([p([t('ab')]), p([t('cd')], { trackedInsert: stamp('s') })])
    expect(texts(apply(s, acceptChange(s, 's')).doc)).toEqual(['ab', 'cd'])
    expect(texts(apply(s, rejectChange(s, 's')).doc)).toEqual(['abcd'])
  })

  it('paragraph join: accept joins; reject keeps them apart', () => {
    const s = state([p([t('ab')]), p([t('cd')], { trackedDelete: stamp('j') })])
    expect(texts(apply(s, acceptChange(s, 'j')).doc)).toEqual(['abcd'])
    const r = apply(s, rejectChange(s, 'j'))
    expect(texts(r.doc)).toEqual(['ab', 'cd'])
    expect(ids(r.doc)).toEqual([])
  })

  it('a split with inserted text in the new paragraph is one unit: reject removes both', () => {
    const s = state([p([t('ab')]), p([t('new', [ins('x')]), t('cd')], { trackedInsert: stamp('x') })])
    expect(texts(apply(s, rejectChange(s, 'x')).doc)).toEqual(['abcd'])
    expect(texts(apply(s, acceptChange(s, 'x')).doc)).toEqual(['ab', 'newcd'])
  })

  it('footnotes: an inserted note goes on reject; a deleted note (and its text) goes on accept', () => {
    const s = state([p([t('a'), fn('Inserted note', [ins('fi')]), t('b'), fn('Deleted note', [del('fd')]), t('c')])])
    const a = apply(s, acceptAll(s))
    expect(footnotes(a.doc)).toEqual(['Inserted note'])
    expect(texts(a.doc)).toEqual(['aInserted notebc'])
    const r = apply(s, rejectAll(s))
    expect(footnotes(r.doc)).toEqual(['Deleted note'])
    expect(ids(a.doc)).toEqual([])
    expect(ids(r.doc)).toEqual([])
  })

  it('breaks: an inserted page break goes on reject; a deleted scene break goes on accept', () => {
    const s = state([p([t('one')]), { type: 'pageBreak', attrs: { trackedInsert: stamp('pb') } }, p([t('two')]), { type: 'sceneBreak', attrs: { trackedDelete: stamp('sb') } }, p([t('three')])])
    expect(texts(apply(s, rejectChange(s, 'pb')).doc)).toEqual(['one', 'two', '[sceneBreak]', 'three'])
    expect(texts(apply(s, acceptChange(s, 'pb')).doc)).toEqual(['one', '[pageBreak]', 'two', '[sceneBreak]', 'three'])
    expect(texts(apply(s, acceptChange(s, 'sb')).doc)).toEqual(['one', '[pageBreak]', 'two', 'three'])
    expect(texts(apply(s, rejectChange(s, 'sb')).doc)).toEqual(['one', '[pageBreak]', 'two', '[sceneBreak]', 'three'])
  })

  it('nested: text inserted by Ann and deleted by Bob', () => {
    const s = state([p([t('x '), t('mid', [ins('a', 'Ann'), del('b', 'Bob')]), t(' y')])])
    // Accept Bob's deletion: the text goes. Reject it: Ann's insertion stays.
    expect(texts(apply(s, acceptChange(s, 'b')).doc)).toEqual(['x  y'])
    const r = apply(s, rejectChange(s, 'b'))
    expect(texts(r.doc)).toEqual(['x mid y'])
    expect(ids(r.doc)).toEqual(['a'])
    // Accept Ann's insertion: Bob's deletion is still pending. Reject it: the text goes.
    const a = apply(s, acceptChange(s, 'a'))
    expect(ids(a.doc)).toEqual(['b'])
    expect(texts(apply(s, rejectChange(s, 'a')).doc)).toEqual(['x  y'])
    // All at once.
    expect(texts(apply(s, acceptAll(s)).doc)).toEqual(['x  y'])
    expect(texts(apply(s, rejectAll(s)).doc)).toEqual(['x  y'])
  })

  it('adjacent changes are resolved one at a time', () => {
    const s = state([p([t('one', [ins('a')]), t('two', [ins('b', 'Bob')]), t('three', [del('c')])])])
    const r = apply(s, rejectChange(s, 'b'))
    expect(texts(r.doc)).toEqual(['onethree'])
    expect(ids(r.doc)).toEqual(['a', 'c'])
    const a = apply(s, acceptChange(s, 'c'))
    expect(texts(a.doc)).toEqual(['onetwo'])
    expect(ids(a.doc)).toEqual(['a', 'b'])
  })

  it('by author: only that author’s changes are resolved; listAuthors in document order', () => {
    const s = state([p([t('ann', [ins('a1', 'Ann')]), t(' bob', [ins('b1', 'Bob')]), t(' gone', [del('a2', 'Ann')])])])
    expect(listAuthors(listChanges(s.doc))).toEqual(['Ann', 'Bob'])
    const a = apply(s, acceptAllByAuthor(s, 'Ann'))
    expect(texts(a.doc)).toEqual(['ann bob'])
    expect(ids(a.doc)).toEqual(['b1'])
    const r = apply(s, rejectAllByAuthor(s, 'Bob'))
    expect(texts(r.doc)).toEqual(['ann gone'])
    expect(ids(r.doc)).toEqual(['a1', 'a2'])
    expect(acceptAllByAuthor(s, 'Nobody')).toBeNull()
  })

  describe('a selection over part of a change resolves only that part (Word)', () => {
    /** Text runs as "text{id}" (ids of tracking marks) or "text" (none). */
    const runs = (doc: PMNode) => {
      const out: string[] = []
      doc.descendants((n) => {
        if (n.isText) {
          const tm = n.marks.filter((m) => ['insertion', 'deletion', 'formatChange'].includes(m.type.name)).map((m) => m.attrs.id)
          const fm = n.marks.filter((m) => ['bold', 'italic'].includes(m.type.name)).map((m) => m.type.name)
          out.push(`${n.text}${tm.length ? `{${tm.join(',')}}` : ''}${fm.length ? `[${fm.join(',')}]` : ''}`)
        }
        return true
      })
      return out.join('|')
    }
    const insDoc = () => state([p([t('ab'), t('inserted', [ins('i')]), t('cd')])])
    const delDoc = () => state([p([t('ab'), t('deleted', [del('d')]), t('cd')])])

    it('insertion: accept / reject the selected letters only', () => {
      const s = insDoc()
      expect(runs(apply(s, acceptChangesInRange(s, 3, 6)).doc)).toBe('abins|erted{i}|cd')
      expect(runs(apply(s, rejectChangesInRange(s, 5, 8)).doc)).toBe('ab|inted{i}|cd')
    })

    it('deletion: accept removes the selected letters; reject keeps them, the rest stays deleted', () => {
      const s = delDoc()
      expect(runs(apply(s, acceptChangesInRange(s, 3, 5)).doc)).toBe('ab|leted{d}|cd')
      expect(runs(apply(s, rejectChangesInRange(s, 3, 5)).doc)).toBe('abde|leted{d}|cd')
    })

    it('format change: only the selected letters keep or lose the new formatting', () => {
      const s = state([p([t('bold', [{ type: 'bold' }, fmt('f', [{ type: 'italic' }])])])])
      expect(runs(apply(s, rejectChangesInRange(s, 1, 3)).doc)).toBe('bo[italic]|ld{f}[bold]')
      expect(runs(apply(s, acceptChangesInRange(s, 1, 3)).doc)).toBe('bo[bold]|ld{f}[bold]')
    })

    it('a selection over parts of two changes resolves both parts; plain text between pieces does not count', () => {
      const s = state([p([t('aa', [ins('x')]), t(' mid '), t('bb', [del('y')])])])
      const a = apply(s, acceptChangesInRange(s, 2, 9))
      expect(runs(a.doc)).toBe('a{x}|a mid |b{y}')
      expect(ids(a.doc)).toEqual(['x', 'y'])
      const r = apply(s, rejectChangesInRange(s, 2, 9))
      expect(runs(r.doc)).toBe('a{x}| mid b|b{y}')
      const split = state([p([t('one', [ins('z')]), t(' plain '), t('two', [ins('z')])])])
      expect(rejectChangesInRange(split, 5, 9)).toBeNull()
    })

    it('a paragraph mark (split / join) is resolved only when the selection includes it', () => {
      // "ab" 1..3, then the boundary at 4; "cdef" 5..9.
      const split = state([p([t('ab')]), p([t('cdef')], { trackedInsert: stamp('s') })])
      // A letter in the middle of the new paragraph: the split stays.
      expect(rejectChangesInRange(split, 6, 7)).toBeNull()
      expect(acceptChangesInRange(split, 6, 7)).toBeNull()
      // From the end of "ab" into "cd": the mark is included.
      expect(texts(apply(split, rejectChangesInRange(split, 2, 6)).doc)).toEqual(['abcdef'])
      const a = apply(split, acceptChangesInRange(split, 2, 6))
      expect(texts(a.doc)).toEqual(['ab', 'cdef'])
      expect(ids(a.doc)).toEqual([])
      // From the paragraph's first letter: the mark (the end of "ab") is not included.
      expect(rejectChangesInRange(split, 5, 7)).toBeNull()
      expect(rejectChangesInRange(split, 5, 6)).toBeNull()
      expect(acceptChangesInRange(split, 5, 6)).toBeNull()
      // Ending exactly at the paragraph's first position, from "ab": included.
      expect(texts(apply(split, rejectChangesInRange(split, 2, 5)).doc)).toEqual(['abcdef'])
      // Ending at the boundary itself (the end of "ab"): not past it, not included.
      expect(rejectChangesInRange(split, 2, 3)).toBeNull()
      // The whole of the new paragraph alone: its own mark (before it) is not included.
      expect(rejectChangesInRange(split, 5, 9)).toBeNull()

      const join = state([p([t('ab')]), p([t('cdef')], { trackedDelete: stamp('j') })])
      expect(acceptChangesInRange(join, 7, 8)).toBeNull()
      expect(rejectChangesInRange(join, 7, 8)).toBeNull()
      expect(texts(apply(join, acceptChangesInRange(join, 1, 6)).doc)).toEqual(['abcdef'])
      const r = apply(join, rejectChangesInRange(join, 1, 6))
      expect(texts(r.doc)).toEqual(['ab', 'cdef'])
      expect(ids(r.doc)).toEqual([])

      // A first-letter selection of a joined paragraph: the join stays.
      expect(acceptChangesInRange(join, 5, 6)).toBeNull()

      // Select All (AllSelection 0..size) resolves every change, the first block's mark included.
      const first = state([p([t('ab')], { trackedInsert: stamp('f0') }), p([t('cd', [ins('c')])], { trackedDelete: stamp('j2') })])
      const all = apply(first, acceptChangesInRange(first, 0, first.doc.content.size))
      expect(ids(all.doc)).toEqual([])
      expect(texts(all.doc)).toEqual(['abcd'])
      // A text selection of everything (1..size-1) cannot reach the first block's mark (no paragraph
      // before it): that mark goes by caret, Next Change or Accept / Reject All.
      const text = apply(first, acceptChangesInRange(first, 1, first.doc.content.size - 1))
      expect(ids(text.doc)).toEqual(['f0'])

      // An inserted paragraph: one selected letter rejects that letter only; the break and the rest stay.
      const inserted = state([p([t('ab')]), p([t('new', [ins('n')])], { trackedInsert: stamp('n') })])
      const one = apply(inserted, rejectChangesInRange(inserted, 6, 7))
      expect(texts(one.doc)).toEqual(['ab', 'nw'])
      expect(ids(one.doc)).toEqual(['n'])
    })

    it('style changes, breaks and footnote atoms the selection touches are resolved whole', () => {
      const styled = state([
        { type: 'heading', attrs: { level: 1, trackedStyleChange: { ...stamp('st'), beforeStyleId: null, beforeType: 'paragraph', beforeAttrs: { styleId: null } } }, content: [t('Title')] },
      ])
      expect(apply(styled, rejectChangesInRange(styled, 2, 3)).doc.firstChild!.type.name).toBe('paragraph')
      const brk = state([p([t('ab')]), { type: 'pageBreak', attrs: { trackedInsert: stamp('pb') } }, p([t('cd')])])
      // From "b" over the break into "c".
      expect(texts(apply(brk, rejectChangesInRange(brk, 2, 7)).doc)).toEqual(['ab', 'cd'])
      const f = state([p([t('a'), fn('Note text', [ins('fi')]), t('b')])])
      // The selection covers "a" and the start of the reference only.
      const r = apply(f, rejectChangesInRange(f, 1, 3))
      expect(footnotes(r.doc)).toEqual([])
    })

    it('a collapsed caret still resolves the whole change, but not from the plain gap between its pieces', () => {
      const s = insDoc()
      expect(runs(apply(s, acceptChangesInRange(s, 5, 5)).doc)).toBe('abinsertedcd')
      const split = state([p([t('one', [ins('z')]), t(' plain '), t('two', [ins('z')])])])
      expect(rejectChangesInRange(split, 7, 7)).toBeNull()
      expect(texts(apply(split, rejectChangesInRange(split, 2, 2)).doc)).toEqual([' plain '])
      const para = state([p([t('ab')]), p([t('cdef')], { trackedInsert: stamp('s') })])
      expect(texts(apply(para, rejectChangesInRange(para, 7, 7)).doc)).toEqual(['abcdef'])
    })
  })

  it('changeIdAt: the text at the caret (innermost), a break beside it, then the block', () => {
    const s = state([p([t('ab'), t('cd', [ins('a'), del('b')]), t('ef')]), p([t('gh')], { trackedInsert: stamp('s') }), { type: 'pageBreak', attrs: { trackedInsert: stamp('pb') } }, p([t('ij')])])
    expect(changeIdAt(s.doc, 4)).toBe('b') // inside "cd": the deletion (innermost)
    expect(changeIdAt(s.doc, 2)).toBeNull() // inside "ab"
    expect(changeIdAt(s.doc, 3)).toBe('b') // just before "cd"
    expect(changeIdAt(s.doc, 10)).toBe('s') // in "gh" (block change)
    const breakPos = s.doc.child(0).nodeSize + s.doc.child(1).nodeSize
    expect(changeIdAt(s.doc, breakPos)).toBe('pb')
  })
})

// ---- On a live editor -------------------------------------------------------------------------------

const editors: Editor[] = []
let offCommands: (() => void) | null = null
function make(content: JSONContent[]): Editor {
  const element = document.createElement('div')
  document.body.append(element)
  const ed = new Editor({ element, extensions: createEditorExtensions(), content: { type: 'doc', content } })
  editors.push(ed)
  return ed
}
const select = (ed: Editor, from: number, to = from) => ed.view.dispatch(ed.state.tr.setSelection(TextSelection.create(ed.state.doc, from, to)))

beforeEach(() => {
  __resetCommandsForTests()
  offCommands = registerTrackChangesCommands()
  useStore.getState().bookActions.setTrackChanges(true)
  useStore.getState().trackChangesActions.setMarkupView('all')
})
afterEach(() => {
  cleanup()
  offCommands?.()
  offCommands = null
  editors.splice(0).forEach((e) => {
    e.destroy()
    ;(e.options.element as HTMLElement).remove()
  })
  __resetReviewActionsForTests()
  __resetReviewStateForTests()
  useStore.getState().bookActions.setTrackChanges(false)
})

const sample = (): JSONContent[] => [
  p([t('Keep '), t('old', [del('d1')]), t('new', [ins('i1', 'Bob')]), t(' end.')]),
  p([t('Second '), t('added', [ins('i2')]), t('.')]),
  { type: 'pageBreak', attrs: { trackedInsert: stamp('pb') } },
  p([t('Third.')], { trackedDelete: stamp('j1', 'Bob') }),
]

describe('review commands on the manuscript', () => {
  it('Accept at the caret: one undo step, nothing new recorded with tracking on', () => {
    const ed = make(sample())
    select(ed, 7) // inside "old"
    expect(resolveSelection('accept')).toBe(true)
    expect(texts(ed.state.doc)[0]).toBe('Keep new end.')
    expect(ids(ed.state.doc)).toEqual(['i1', 'i2', 'pb', 'j1'])
    undo(ed.state, ed.view.dispatch)
    expect(texts(ed.state.doc)[0]).toBe('Keep oldnew end.')
    expect(ids(ed.state.doc)).toEqual(['d1', 'i1', 'i2', 'pb', 'j1'])
  })

  it('Reject over a selection: every change it touches, one undo step', () => {
    const ed = make(sample())
    select(ed, 1, ed.state.doc.child(0).nodeSize + 13) // to the end of "added"
    expect(resolveSelection('reject')).toBe(true)
    expect(texts(ed.state.doc).slice(0, 2)).toEqual(['Keep old end.', 'Second .'])
    expect(ids(ed.state.doc)).toEqual(['pb', 'j1'])
    undo(ed.state, ed.view.dispatch)
    expect(ids(ed.state.doc)).toEqual(['d1', 'i1', 'i2', 'pb', 'j1'])
  })

  it('Accept All / Reject All: one transaction, one undo step, never recorded', () => {
    const ed = make(sample())
    return (async () => {
      expect(await resolveAll('accept')).toBe(true)
      // The join after a break cannot join (no paragraph before it): it is left as it is.
      expect(texts(ed.state.doc)).toEqual(['Keep new end.', 'Second added.', '[pageBreak]', 'Third.'])
      expect(ids(ed.state.doc)).toEqual([])
      undo(ed.state, ed.view.dispatch)
      expect(ids(ed.state.doc)).toHaveLength(5)
      expect(await resolveAll('reject')).toBe(true)
      expect(texts(ed.state.doc)).toEqual(['Keep old end.', 'Second .', 'Third.'])
      expect(ids(ed.state.doc)).toEqual([])
    })()
  })

  it('Accept All by author (commands listed per author present)', async () => {
    const ed = make(sample())
    refreshChangeSummary(ed.state.doc)
    expect(getChangeSummary().authors).toEqual(['Ann', 'Bob'])
    const bob = getCommand(byAuthorCommandId('accept', 'Bob'))!
    expect(bob.label).toBe('Bob')
    expect(bob.menu?.submenu).toBe('Accept All by Author')
    expect(getCommand(byAuthorCommandId('reject', 'Ann'))!.label).toBe('Ann')
    bob.run()
    await vi.waitFor(() => expect(ids(ed.state.doc)).toEqual(['d1', 'i2', 'pb']))
    // The by-author items follow the authors present.
    await vi.waitFor(() => expect(getCommand(byAuthorCommandId('accept', 'Bob'))).toBeUndefined())
    expect(getCommand(byAuthorCommandId('accept', 'Ann'))!.label).toBe('Ann')
    // A stale item (Bob has no changes left) does nothing.
    expect(await bob.run()).toBeUndefined()
    expect(ids(ed.state.doc)).toEqual(['d1', 'i2', 'pb'])
  })

  it('more than 50 changes: asks first; Cancel leaves everything', async () => {
    const many = Array.from({ length: CONFIRM_ABOVE + 1 }, (_, i) => p([t(`w${i}`, [ins(`c${i}`)])]))
    const ed = make(many)
    const ask = vi.fn(async () => false)
    setReviewConfirm(ask)
    expect(await resolveAll('reject')).toBe(false)
    expect(ask).toHaveBeenCalledOnce()
    expect(ask.mock.calls[0]).toEqual([expect.objectContaining({ confirmLabel: 'Reject All' })])
    expect(ids(ed.state.doc)).toHaveLength(CONFIRM_ABOVE + 1)
    ask.mockImplementation(async () => true)
    expect(await resolveAll('accept')).toBe(true)
    expect(ids(ed.state.doc)).toHaveLength(0)
    // 50 or fewer: no question.
    ask.mockClear()
    const few = make(Array.from({ length: CONFIRM_ABOVE }, (_, i) => p([t(`w${i}`, [ins(`f${i}`)])])))
    expect(await resolveAll('accept')).toBe(true)
    expect(ask).not.toHaveBeenCalled()
    expect(ids(few.state.doc)).toHaveLength(0)
  })

  it('Next / Previous Change select each change in order and wrap; Accept then acts on that change only', () => {
    const ed = make(sample())
    select(ed, 1)
    const seen: string[] = []
    for (let i = 0; i < 5; i++) {
      nextChange()
      const sel = ed.state.selection
      seen.push(sel instanceof NodeSelection ? `[${sel.node.type.name}]` : ed.state.doc.textBetween(sel.from, sel.to) || `@${ed.state.doc.resolve(sel.from).parent.textContent}`)
    }
    expect(seen).toEqual(['old', 'new', 'added', '[pageBreak]', '@Third.'])
    nextChange()
    expect(ed.state.doc.textBetween(ed.state.selection.from, ed.state.selection.to)).toBe('old') // wrapped
    prevChange()
    expect(ed.state.selection).toBeInstanceOf(TextSelection)
    expect(ed.state.doc.resolve(ed.state.selection.from).parent.textContent).toBe('Third.')
    prevChange()
    expect(ed.state.selection).toBeInstanceOf(NodeSelection)
    // Accept the selected break: only it (not the join after it).
    resolveSelection('accept')
    expect(ids(ed.state.doc)).toEqual(['d1', 'i1', 'i2', 'j1'])
  })

  it('Reject and Move to Next: rejects at the caret, then selects the next change', () => {
    const ed = make(sample())
    select(ed, 7)
    expect(resolveAndNext('reject')).toBe(true)
    expect(texts(ed.state.doc)[0]).toBe('Keep oldnew end.')
    expect(ids(ed.state.doc)).toEqual(['i1', 'i2', 'pb', 'j1'])
    expect(ed.state.doc.textBetween(ed.state.selection.from, ed.state.selection.to)).toBe('new')
    // The selected change is the one Accept acts on.
    runCommand('review.acceptNext')
    expect(ids(ed.state.doc)).toEqual(['i2', 'pb', 'j1'])
    expect(ed.state.doc.textBetween(ed.state.selection.from, ed.state.selection.to)).toBe('added')
  })

  it('registers the review commands in the Review menu with guards', () => {
    make(sample())
    const review = getCommands().filter((c) => c.menu?.id === 'review').map((c) => c.id)
    for (const id of ['review.change.prev', 'review.change.next', 'review.change.show', 'review.accept', 'review.acceptNext', 'review.acceptAll', 'review.reject', 'review.rejectNext', 'review.rejectAll'])
      expect(review).toContain(id)
    expect(getCommand('review.accept')!.guard).toBe('manuscript')
    expect(getCommand('review.acceptAll')!.guard).toBe('modal')
    expect(getCommand('review.change.next')!.guard).toBe('none')
  })
})

describe('change popover and status bar', () => {
  it('opens for the change at the caret (Show Change Details) with author, kind and preview; Accept resolves', () => {
    const ed = make(sample())
    select(ed, 9) // inside "new" (Bob)
    render(<ChangePopover />)
    act(() => void showChangeAtCaret())
    const pop = screen.getByTestId('change-popover')
    expect(pop.dataset.changeId).toBe('i1')
    expect(screen.getByTestId('change-popover-author').textContent).toBe('Bob')
    expect(screen.getByTestId('change-popover-kind').textContent).toBe('Inserted: new')
    expect(document.activeElement?.getAttribute('data-control-id')).toBe('review.popover.accept')
    act(() => void fireEvent.click(screen.getByRole('button', { name: 'Reject' })))
    expect(screen.queryByTestId('change-popover')).toBeNull()
    expect(texts(ed.state.doc)[0]).toBe('Keep old end.')
  })

  it('Escape closes it; it does not open in No Markup or on plain text', () => {
    const ed = make(sample())
    render(<ChangePopover />)
    select(ed, 7)
    act(() => void showChangeAtCaret())
    act(() => void fireEvent.keyDown(screen.getByTestId('change-popover'), { key: 'Escape' }))
    expect(getChangePopover()).toBeNull()
    select(ed, 2)
    act(() => void showChangeAtCaret())
    expect(getChangePopover()).toBeNull()
    act(() => useStore.getState().trackChangesActions.setMarkupView('none'))
    select(ed, 7)
    act(() => void showChangeAtCaret())
    expect(getChangePopover()).toBeNull()
  })

  it('a click lands on the innermost tracked span', () => {
    const ed = make([p([t('x '), t('mid', [ins('a', 'Ann'), del('b', 'Bob')]), t(' y')])])
    const spans = ed.view.dom.querySelectorAll('[data-tc-del]')
    expect(changeAtClick(ed.view, spans[0], 4)?.id).toBe('b')
    expect(changeAtClick(ed.view, ed.view.dom.querySelector('p'), 1)).toBeNull()
    expect(describeChange(ed.state.doc, 'b')).toMatchObject({ kind: 'Deleted', preview: 'mid' })
  })

  it('relative dates', () => {
    const now = Date.parse('2026-03-10T12:00:00Z')
    expect(relativeDate('2026-03-10T11:59:30Z', now)).toBe('just now')
    expect(relativeDate('2026-03-10T11:55:00Z', now)).toBe('5 minutes ago')
    expect(relativeDate('2026-03-09T12:00:00Z', now)).toBe('yesterday')
    expect(relativeDate('not a date', now)).toBe('')
  })

  it('"N changes" in the status bar goes to the next change', () => {
    const ed = make(sample())
    refreshChangeSummary(ed.state.doc)
    render(<ChangesIndicator />)
    const btn = screen.getByTestId('changes-indicator')
    expect(btn.textContent).toBe('5 changes')
    select(ed, 1)
    fireEvent.click(btn)
    expect(ed.state.doc.textBetween(ed.state.selection.from, ed.state.selection.to)).toBe('old')
  })
})

describe('the manuscript view only', () => {
  it('another editor with TrackChanges never takes the review commands (source set by the root)', async () => {
    const manuscript = make(sample())
    setReviewViewSource(() => manuscript.view)
    // A second editor built later (the re-write view), with the extension's review side on or off.
    const other = make([p([t('x'), t('y', [ins('o1')])])])
    const quiet = new Editor({
      element: document.createElement('div'),
      extensions: createEditorExtensions().map((e) => (e.name === 'trackChanges' ? TrackChanges.configure({ review: false }) : e)),
      content: { type: 'doc', content: [p([t('z', [ins('o2')])])] },
    })
    expect(getReviewView()).toBe(manuscript.view)
    select(manuscript, 1)
    nextChange()
    expect(manuscript.state.doc.textBetween(manuscript.state.selection.from, manuscript.state.selection.to)).toBe('old')
    expect(await resolveAll('accept')).toBe(true)
    expect(ids(manuscript.state.doc)).toEqual([])
    expect(ids(other.state.doc)).toEqual(['o1'])
    // Closing the other editors leaves the review working.
    quiet.destroy()
    editors.splice(editors.indexOf(other), 1)
    other.destroy()
    expect(getReviewView()).toBe(manuscript.view)
    undo(manuscript.state, manuscript.view.dispatch)
    expect(resolveSelection('reject')).toBe(true)
  })

  it('without a source, a destroyed editor hands the review back to the one before it', () => {
    const a = make(sample())
    const b = make([p([t('b', [ins('bx')])])])
    expect(getReviewView()).toBe(b.view)
    editors.splice(editors.indexOf(b), 1)
    b.destroy()
    expect(getReviewView()).toBe(a.view)
  })

  it('Accept works right after an edit or undo (no wait for the debounced count)', () => {
    const ed = make([p([t('plain')])])
    expect(getCommand('review.accept')!.isEnabled!()).toBe(false)
    // Typed with tracking on: recorded as an insertion.
    ed.view.dispatch(ed.state.tr.insertText('new', 1))
    expect(ids(ed.state.doc)).toHaveLength(1)
    expect(getCommand('review.accept')!.isEnabled!()).toBe(true)
    expect(getCommand('review.change.next')!.isEnabled!()).toBe(true)
  })

  it('the popover closes on any document change (typing, a load), even with the focus in it', () => {
    const ed = make(sample())
    render(<ChangePopover />)
    select(ed, 7)
    act(() => void showChangeAtCaret())
    expect(document.activeElement?.getAttribute('data-control-id')).toBe('review.popover.accept')
    act(() => ed.view.dispatch(ed.state.tr.insertText('x', 1)))
    expect(getChangePopover()).toBeNull()
    expect(screen.queryByTestId('change-popover')).toBeNull()
    // A document load (the controller replaces the state with the same plugins).
    select(ed, 8)
    act(() => void showChangeAtCaret())
    expect(getChangePopover()).not.toBeNull()
    act(() => ed.view.updateState(EditorState.create({ schema: ed.schema, doc: ed.schema.nodeFromJSON({ type: 'doc', content: sample() }), plugins: ed.state.plugins })))
    expect(getChangePopover()).toBeNull()
  })
})
