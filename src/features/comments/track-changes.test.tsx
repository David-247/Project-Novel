import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Editor } from '@tiptap/core'
import { undo } from '@tiptap/pm/history'
import type { Node as PMNode, Slice } from '@tiptap/pm/model'
import { TextSelection } from '@tiptap/pm/state'
import { getEditor, NovelEditor, setDocJSON, type JSONContent } from '@/features/editor'
import { acceptAll, listChanges, rejectAll } from '@/features/track-changes'
import { useStore } from '@/shared/store'
import { collectAnchors } from './anchors'
import { deleteThread, newComment, replyToThread, resolveThread, submitDraft } from './commands'
import { filterPastedComments, setCommentAuthorSource } from './extension'
import { __resetCommentsFileForTests } from './persistence'

/**
 * Comments and track changes together (integration): thread actions are never recorded as tracked
 * changes, comment marks survive tracked deletions, and accept / reject keep them on surviving text.
 */

beforeAll(() => {
  const rect = { x: 0, y: 0, top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0, toJSON: () => ({}) }
  const emptyRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList
  Range.prototype.getClientRects ??= emptyRects
  Range.prototype.getBoundingClientRect ??= () => rect as DOMRect
  Element.prototype.getClientRects ??= emptyRects
  document.elementFromPoint ??= () => null
})

const text = (t: string): JSONContent => ({ type: 'text', text: t })
const DOC = [{ type: 'paragraph', content: [text('The quick brown fox jumps.')] }]

function mount(): Editor {
  render(<NovelEditor />)
  act(() => setDocJSON({ type: 'doc', content: DOC }))
  return getEditor()!
}

const select = (ed: Editor, from: number, to: number) => ed.view.dispatch(ed.state.tr.setSelection(TextSelection.create(ed.state.doc, from, to)))
const threads = () => useStore.getState().comments.threads
/** "quick brown": positions 5..16 in the first paragraph. */
const Q = { from: 5, to: 16 }

function addComment(ed: Editor, from: number, to: number, body = 'A note'): string {
  select(ed, from, to)
  act(() => void newComment())
  let id: string | null = null
  act(() => void (id = submitDraft(body)))
  return id!
}

/** The text under `id`'s comment mark. */
function commented(doc: PMNode, id: string): string {
  let out = ''
  doc.descendants((n) => {
    if (n.isText && n.marks.some((m) => m.type.name === 'comment' && m.attrs.id === id)) out += n.text
  })
  return out
}

beforeEach(() => {
  setCommentAuthorSource(() => ({ name: 'Ada' }))
  __resetCommentsFileForTests()
  useStore.getState().bookActions.setTrackChanges(true)
  useStore.getState().trackChangesActions.setMarkupView('all')
})

afterEach(() => {
  cleanup()
  act(() => useStore.getState().commentsActions.threadsChanged([], 0))
  useStore.getState().bookActions.resetBook()
})

describe('comments while Track Changes records', () => {
  it('thread actions are not tracked changes, and each still undoes in one step', () => {
    const ed = mount()
    const id = addComment(ed, Q.from, Q.to)
    expect(listChanges(ed.state.doc)).toEqual([])
    expect(commented(ed.state.doc, id)).toBe('quick brown')
    act(() => void replyToThread(id, 'A reply'))
    act(() => void resolveThread(id))
    expect(listChanges(ed.state.doc)).toEqual([])
    expect(threads()[0].messages).toHaveLength(2)
    expect(threads()[0].resolved).toBe(true)
    act(() => void undo(ed.state, ed.view.dispatch))
    expect(threads()[0].resolved).toBe(false)
    act(() => void deleteThread(id))
    expect(listChanges(ed.state.doc)).toEqual([])
    expect(collectAnchors(ed.state.doc).has(id)).toBe(false)
    act(() => void undo(ed.state, ed.view.dispatch))
    expect(commented(ed.state.doc, id)).toBe('quick brown')
  })

  it('a tracked deletion of commented text keeps the comment mark, and the thread stays anchored', () => {
    const ed = mount()
    const id = addComment(ed, Q.from, Q.to)
    act(() => {
      select(ed, Q.from, Q.from + 6) // "quick "
      ed.commands.deleteSelection()
    })
    expect(listChanges(ed.state.doc).flatMap((c) => c.kinds)).toContain('deletion')
    expect(ed.state.doc.textContent).toBe('The quick brown fox jumps.')
    expect(commented(ed.state.doc, id)).toBe('quick brown')
    expect(collectAnchors(ed.state.doc).has(id)).toBe(true)
  })

  it('reject keeps the comment on the original text; accept keeps it on what survives', () => {
    const ed = mount()
    const id = addComment(ed, Q.from, Q.to)
    act(() => {
      select(ed, Q.from, Q.from + 6)
      ed.commands.deleteSelection()
    })
    const afterDelete = ed.state
    const rejected = afterDelete.apply(rejectAll(afterDelete)!)
    expect(listChanges(rejected.doc)).toEqual([])
    expect(commented(rejected.doc, id)).toBe('quick brown')
    const accepted = afterDelete.apply(acceptAll(afterDelete)!)
    expect(accepted.doc.textContent).toBe('The brown fox jumps.')
    expect(commented(accepted.doc, id)).toBe('brown')
  })
})

/** End of the first paragraph's text. */
const END = 27

/** Paste `slice` at `at` as ProseMirror does: the comment paste rule, then replace the selection. */
function paste(ed: Editor, slice: Slice, at: number) {
  const filtered = filterPastedComments(slice, ed.state, false)
  act(() => {
    const tr = ed.state.tr.setSelection(TextSelection.create(ed.state.doc, at)).replaceSelection(filtered)
    ed.view.dispatch(tr.setMeta('uiEvent', 'paste'))
  })
}

/** Drag `from..to` to `at` (after it) with move, as ProseMirror's drop does. */
function dragMove(ed: Editor, from: number, to: number, at: number) {
  const filtered = filterPastedComments(ed.state.doc.slice(from, to), ed.state, true)
  act(() => {
    const tr = ed.state.tr.replace(at, at, filtered).delete(from, to)
    ed.view.dispatch(tr.setMeta('uiEvent', 'drop'))
  })
}

/** One live anchor, on exactly `text`. */
function expectOneAnchor(doc: PMNode, id: string, text: string) {
  const a = collectAnchors(doc).get(id)
  expect(a, 'anchored').toBeTruthy()
  expect(doc.textBetween(a!.from, a!.to)).toBe(text)
  expect(commented(doc, id)).toBe(text)
}

describe('moving commented text (cut and paste, drag)', () => {
  for (const how of ['cut and paste', 'drag-move'] as const) {
    it(`${how} while Track Changes records moves the comment; accept and reject each leave one anchor`, () => {
      const ed = mount()
      const id = addComment(ed, Q.from, Q.to)
      if (how === 'cut and paste') {
        const slice = ed.state.doc.slice(Q.from, Q.to)
        act(() => {
          select(ed, Q.from, Q.to)
          ed.commands.deleteSelection()
        })
        paste(ed, slice, END)
      } else dragMove(ed, Q.from, Q.to, END)
      // Pending: the original is a tracked deletion; the anchor is the new place only.
      const a = collectAnchors(ed.state.doc).get(id)!
      expect(a.deletedOnly).toBe(false)
      expect(ed.state.doc.textBetween(a.from, a.to)).toBe('quick brown')
      expect(a.from).toBeGreaterThanOrEqual(END)
      const pending = ed.state
      const accepted = pending.apply(acceptAll(pending)!)
      expect(accepted.doc.textContent).toBe('The  fox jumps.quick brown')
      expectOneAnchor(accepted.doc, id, 'quick brown')
      const rejected = pending.apply(rejectAll(pending)!)
      expect(rejected.doc.textContent).toBe('The quick brown fox jumps.')
      expectOneAnchor(rejected.doc, id, 'quick brown')
    })
  }

  it('without Track Changes: copy and paste does not duplicate the comment, cut and paste moves it', () => {
    useStore.getState().bookActions.setTrackChanges(false)
    const ed = mount()
    const id = addComment(ed, Q.from, Q.to)
    const slice = ed.state.doc.slice(Q.from, Q.to)
    paste(ed, slice, END)
    expectOneAnchor(ed.state.doc, id, 'quick brown')
    expect(collectAnchors(ed.state.doc).get(id)!.from).toBe(Q.from)
    act(() => void undo(ed.state, ed.view.dispatch))
    act(() => {
      select(ed, Q.from, Q.to)
      ed.commands.deleteSelection()
    })
    paste(ed, slice, END - (Q.to - Q.from))
    expect(ed.state.doc.textContent).toBe('The  fox jumps.quick brown')
    expectOneAnchor(ed.state.doc, id, 'quick brown')
  })

  it('without Track Changes: drag-move keeps one anchor at the new place', () => {
    useStore.getState().bookActions.setTrackChanges(false)
    const ed = mount()
    const id = addComment(ed, Q.from, Q.to)
    dragMove(ed, Q.from, Q.to, END)
    expect(ed.state.doc.textContent).toBe('The  fox jumps.quick brown')
    expectOneAnchor(ed.state.doc, id, 'quick brown')
  })
})
