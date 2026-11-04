import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Editor, Mark } from '@tiptap/core'
import { redo, undo } from '@tiptap/pm/history'
import { Fragment, Slice } from '@tiptap/pm/model'
import { TextSelection } from '@tiptap/pm/state'
import { createEditorExtensions, getDocJSON, getEditor, isDirty, NovelEditor, setDocJSON, type JSONContent } from '@/features/editor'
import { auditTooltipCoverage, formatCoverageProblems } from '@/features/tooltips'
import { getTooltipCopy } from '@/features/tooltips'
import { useStore } from '@/shared/store'
import { TooltipProvider } from '@/shared/ui'
import { collectAnchors } from './anchors'
import {
  deleteMessage,
  deleteThread,
  editMessage,
  newComment,
  nextComment,
  prevComment,
  reopenThread,
  replyToThread,
  resolveThread,
  submitDraft,
  wordAt,
} from './commands'
import { CommentsLayout } from './CommentsLayout'
import { commentsKey, filterPastedComments, getCommentsView, setCommentAuthorSource } from './extension'
import { commentsSideFile, __resetCommentsFileForTests } from './persistence'

beforeAll(() => {
  const rect = { x: 0, y: 0, top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0, toJSON: () => ({}) }
  const emptyRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList
  Range.prototype.getClientRects ??= emptyRects
  Range.prototype.getBoundingClientRect ??= () => rect as DOMRect
  Element.prototype.getClientRects ??= emptyRects
  document.elementFromPoint ??= () => null
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})

const text = (t: string, marks?: JSONContent['marks']): JSONContent => ({ type: 'text', text: t, ...(marks ? { marks } : {}) })
const p = (...content: JSONContent[]): JSONContent => ({ type: 'paragraph', content })
const DOC = [p(text('The quick brown fox jumps over the lazy dog.')), p(text('Second paragraph here.'))]

function mount(content: JSONContent[] = DOC): Editor {
  render(<NovelEditor />)
  act(() => setDocJSON({ type: 'doc', content }))
  return getEditor()!
}

const threads = () => useStore.getState().comments.threads
const shown = (ed: Editor) => [...collectAnchors(ed.state.doc).keys()]
const select = (ed: Editor, from: number, to: number) => ed.view.dispatch(ed.state.tr.setSelection(TextSelection.create(ed.state.doc, from, to)))
const doUndo = (ed: Editor) => act(() => void undo(ed.state, ed.view.dispatch))
const doRedo = (ed: Editor) => act(() => void redo(ed.state, ed.view.dispatch))

/** Select `from..to`, open the composer and submit `body`. Returns the thread id. */
function addComment(ed: Editor, from: number, to: number, body = 'A note'): string {
  select(ed, from, to)
  act(() => void newComment())
  let id: string | null = null
  act(() => void (id = submitDraft(body)))
  return id!
}

beforeEach(() => {
  setCommentAuthorSource(() => ({ name: 'Ada', color: '#c0392b' }))
  __resetCommentsFileForTests()
})

afterEach(() => {
  cleanup()
  act(() => {
    useStore.getState().commentsActions.threadsChanged([], 0)
    useStore.getState().commentsActions.setActive(null)
    useStore.getState().commentsActions.setShowResolved(false)
  })
  setDocJSON({ type: 'doc', content: [{ type: 'paragraph' }] })
  setCommentAuthorSource(null)
})

describe('anchoring', () => {
  it('a comment marks the selection and creates its thread in one undo step', () => {
    const ed = mount()
    const id = addComment(ed, 5, 10)
    expect(ed.state.doc.textBetween(5, 10)).toBe('quick')
    expect(collectAnchors(ed.state.doc).get(id)).toEqual({ id, from: 5, to: 10 })
    expect(threads()).toHaveLength(1)
    expect(threads()[0]).toMatchObject({ id, author: 'Ada', authorColor: '#c0392b', messages: [{ text: 'A note' }] })
    expect(isDirty()).toBe(true)
    doUndo(ed)
    expect(threads()).toHaveLength(0)
    expect(shown(ed)).toEqual([])
    doRedo(ed)
    expect(threads().map((t) => t.id)).toEqual([id])
    expect(shown(ed)).toEqual([id])
  })

  it('a collapsed caret anchors to the word at the caret', () => {
    const ed = mount()
    expect(wordAt(ed.state, 13)).toEqual({ from: 11, to: 16 }) // in "brown"
    expect(wordAt(ed.state, 16)).toEqual({ from: 11, to: 16 }) // just after it
    const id = addComment(ed, 13, 13)
    expect(ed.state.doc.textBetween(...(Object.values(collectAnchors(ed.state.doc).get(id)!).slice(1) as [number, number]))).toBe('brown')
  })

  it('comments overlap each other (excludes: none)', () => {
    const ed = mount()
    const a = addComment(ed, 5, 16)
    const b = addComment(ed, 11, 20)
    const anchors = collectAnchors(ed.state.doc)
    expect(anchors.get(a)).toMatchObject({ from: 5, to: 16 })
    expect(anchors.get(b)).toMatchObject({ from: 11, to: 20 })
    const json = JSON.stringify(getDocJSON())
    expect(json).toContain(`"id":"${a}"`)
    expect(json).toContain(`"id":"${b}"`)
  })

  it('an empty selection with no word does nothing', () => {
    const ed = mount([p(text('   '))])
    select(ed, 2, 2)
    expect(newComment()).toBe(false)
  })
})

describe('every thread action undoes and redoes with the main history', () => {
  it('reply, edit, delete reply, resolve, reopen, delete thread', () => {
    const ed = mount()
    const id = addComment(ed, 5, 10, 'First')
    const t = () => threads().find((x) => x.id === id)
    const step = (label: string, action: () => boolean, check: () => void) => {
      const before = JSON.stringify(threads())
      act(() => expect(action(), label).toBe(true))
      check()
      doUndo(ed)
      expect(JSON.stringify(threads()), `${label} undone`).toBe(before)
      doRedo(ed)
      check()
    }
    step('reply', () => replyToThread(id, 'Second\nline'), () => expect(t()!.messages.map((m) => m.text)).toEqual(['First', 'Second\nline']))
    const reply = t()!.messages[1].id
    step('edit', () => editMessage(id, reply, 'Changed'), () => expect(t()!.messages[1]).toMatchObject({ text: 'Changed', editedAt: expect.any(String) }))
    step('delete reply', () => deleteMessage(id, reply), () => expect(t()!.messages).toHaveLength(1))
    step('resolve', () => resolveThread(id), () => expect(t()).toMatchObject({ resolved: true, resolvedBy: 'Ada' }))
    step('reopen', () => reopenThread(id), () => expect(t()!.resolved).toBe(false))
    step('delete', () => deleteThread(id), () => {
      expect(t()).toBeUndefined()
      expect(shown(ed)).toEqual([])
    })
    doUndo(ed)
    expect(shown(ed)).toEqual([id])
  })

  it('only the author edits a message', () => {
    const ed = mount()
    const id = addComment(ed, 5, 10, 'Mine')
    setCommentAuthorSource(() => ({ name: 'Bo' }))
    expect(editMessage(id, threads()[0].messages[0].id, 'Not mine')).toBe(false)
    expect(ed).toBeTruthy()
  })
})

describe('anchor deletion', () => {
  it('deleting the anchored text hides the thread; undo brings it back with its replies', () => {
    const ed = mount()
    const id = addComment(ed, 5, 10)
    act(() => void replyToThread(id, 'reply'))
    act(() => ed.view.dispatch(ed.state.tr.delete(4, 11)))
    expect(shown(ed)).toEqual([])
    expect(threads().map((t) => t.id)).toEqual([id]) // hidden, not destroyed
    doUndo(ed)
    expect(shown(ed)).toEqual([id])
    expect(threads()[0].messages).toHaveLength(2)
  })

  it('orphans are kept on save and pruned on close', () => {
    const ed = mount()
    const keep = addComment(ed, 5, 10)
    const gone = addComment(ed, 24, 28)
    act(() => ed.view.dispatch(ed.state.tr.delete(23, 29)))
    const saved = commentsSideFile.serialize().data as { threads: { id: string }[] }
    expect(saved.threads.map((t) => t.id).sort()).toEqual([keep, gone].sort())
    const closing = commentsSideFile.closeData!() as { threads: { id: string }[] }
    expect(closing.threads.map((t) => t.id)).toEqual([keep])
    // Opening a project drops orphans too (nothing can bring them back after a restart).
    act(() => void commentsSideFile.load(saved))
    expect(threads().map((t) => t.id)).toEqual([keep])
  })
})

describe('copy and paste', () => {
  it('a pasted copy within the manuscript loses the mark; after a cut the paste keeps it (moves)', () => {
    const ed = mount()
    const id = addComment(ed, 5, 10)
    const copied = ed.state.doc.slice(5, 10)
    const filtered = filterPastedComments(copied, ed.state)
    let marked = false
    filtered.content.descendants((n) => void (marked ||= n.marks.some((m) => m.type.name === 'comment')))
    expect(marked).toBe(false)
    // Cut: the anchor is gone, so the clipboard's mark is kept.
    act(() => ed.view.dispatch(ed.state.tr.delete(5, 10)))
    const moved = filterPastedComments(copied, ed.state)
    let kept = false
    moved.content.descendants((n) => void (kept ||= n.marks.some((m) => m.attrs.id === id)))
    expect(kept).toBe(true)
    // A mark without a thread (another manuscript) is dropped.
    const foreign = new Slice(Fragment.from(ed.schema.text('x', [ed.schema.marks.comment.create({ id: 'c-unknown' })])), 0, 0)
    expect(filterPastedComments(foreign, ed.state).content.firstChild!.marks).toEqual([])
  })
})

describe('next and previous comment', () => {
  it('walk the shown threads in document order and wrap; resolved ones are skipped', () => {
    const ed = mount()
    const a = addComment(ed, 5, 10)
    const b = addComment(ed, 11, 16)
    const c = addComment(ed, 47, 53)
    select(ed, 1, 1)
    act(() => useStore.getState().commentsActions.setActive(null))
    act(() => void nextComment())
    expect(useStore.getState().comments.activeId).toBe(a)
    act(() => void nextComment())
    expect(useStore.getState().comments.activeId).toBe(b)
    expect(ed.state.selection).toMatchObject({ from: 11, to: 16 })
    act(() => void resolveThread(c))
    act(() => void nextComment())
    expect(useStore.getState().comments.activeId).toBe(a)
    act(() => void prevComment())
    expect(useStore.getState().comments.activeId).toBe(b)
  })
})

describe('coexistence with other marks (track changes)', () => {
  it('a comment on text carrying another mark keeps both; deleting the comment leaves the other mark', () => {
    const Tracked = Mark.create({
      name: 'dummyDeletion',
      addAttributes: () => ({ id: { default: null } }),
      renderHTML: () => ['del', 0],
      parseHTML: () => [{ tag: 'del' }],
    })
    const el = document.createElement('div')
    document.body.appendChild(el)
    const ed = new Editor({ element: el, extensions: [...createEditorExtensions(), Tracked] })
    ed.commands.setContent({ type: 'doc', content: [p(text('one two three'))] })
    const tr = ed.state.tr.addMark(5, 8, ed.schema.marks.dummyDeletion.create({ id: 'd1' }))
    ed.view.dispatch(tr)
    expect(getCommentsView()).toBe(ed.view)
    const id = addComment(ed, 1, 12, 'about this')
    const marksAt = (pos: number) => ed.state.doc.nodeAt(pos)!.marks.map((m) => m.type.name).sort()
    expect(marksAt(5)).toEqual(['comment', 'dummyDeletion'])
    // Still shown: the comment stays visible on text under another mark.
    expect([...collectAnchors(ed.state.doc).keys()]).toEqual([id])
    act(() => void deleteThread(id))
    expect(marksAt(5)).toEqual(['dummyDeletion'])
    ed.destroy()
    el.remove()
  })
})

describe('margin panel', () => {
  it('shows a card per thread with every control registered and wired', () => {
    const ed = mount()
    addComment(ed, 5, 10, 'Look here')
    const { container } = render(
      <TooltipProvider lookup={getTooltipCopy}>
        <CommentsLayout>
          <div />
        </CommentsLayout>
      </TooltipProvider>,
    )
    expect(container.querySelector('[data-testid="comments-panel"]')).not.toBeNull()
    expect(container.textContent).toContain('Look here')
    const problems = auditTooltipCoverage(container)
    expect(problems, formatCoverageProblems(problems)).toEqual([])
    expect(commentsKey.getState(ed.state)?.threads.size).toBe(1)
  })
})
