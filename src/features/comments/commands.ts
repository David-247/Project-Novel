import { closeHistory, redo, undo } from '@tiptap/pm/history'
import { TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import { useStore } from '@/shared/store'
import { anchorsInOrder, COMMENT_MARK, collectAnchors, type Anchor } from './anchors'
import { commandHooks, commentsKey, currentAuthor, getCommentsView, sortedThreads, type CommentsMeta } from './extension'
import {
  cleanText,
  createThread,
  newCommentId,
  withEditedMessage,
  withoutMessage,
  withReply,
  withResolved,
  type CommentThread,
} from './model'
import { CommentThreadStep } from './step'

/**
 * Comment commands (plain functions; the controller wires them to the command registry and menus).
 * Every thread action is one transaction with a CommentThreadStep and its own undo event
 * (closeHistory), so create, reply, edit, resolve, reopen and delete each undo with the main history.
 * They return false when they did nothing (no editor, no such thread, empty text).
 */

const store = () => useStore.getState()
const actions = () => store().commentsActions

function view(): EditorView | null {
  return getCommentsView()
}

function threadsOf(state: EditorState): ReadonlyMap<string, CommentThread> {
  return commentsKey.getState(state)?.threads ?? new Map()
}

/** True when the window shows the drawer instead of the margin panel (set by the panel). */
let narrow = false
const narrowListeners = new Set<() => void>()
export function setCommentsNarrow(isNarrow: boolean): void {
  if (narrow === isNarrow) return
  narrow = isNarrow
  narrowListeners.forEach((cb) => cb())
}
export const isCommentsNarrow = () => narrow
export function subscribeCommentsNarrow(cb: () => void): () => void {
  narrowListeners.add(cb)
  return () => narrowListeners.delete(cb)
}

/** Show the comments (margin panel, or the drawer in a narrow window). */
function showComments(): void {
  if (narrow) actions().setDrawerOpen(true)
  else actions().setPanelOpen(true)
}

function dispatchThreadChange(v: EditorView, tr: Transaction, before: CommentThread | null, after: CommentThread | null, id: string) {
  tr.step(new CommentThreadStep(id, before, after))
  closeHistory(tr)
  v.dispatch(tr)
}

const WORD_CHAR = /[\p{L}\p{N}\p{M}'’_-]/u

/** The word at a collapsed caret, as a document range, or null when the caret touches no word. */
export function wordAt(state: EditorState, pos: number): { from: number; to: number } | null {
  const $pos = state.doc.resolve(pos)
  const parent = $pos.parent
  if (!parent.isTextblock && !parent.inlineContent) return null
  const offset = $pos.parentOffset
  // The text node holding the caret, or the one ending at it.
  let child = parent.childAfter(offset)
  let start = child.offset
  if (!child.node?.isText || !WORD_CHAR.test(child.node.text![offset - start] ?? '')) {
    const before = offset > 0 ? parent.childBefore(offset) : null
    if (before?.node?.isText && WORD_CHAR.test(before.node.text![offset - before.offset - 1] ?? '')) child = before
    else if (!child.node?.isText) return null
    start = child.offset
  }
  const text = child.node!.text!
  let a = offset - start
  let b = a
  while (a > 0 && WORD_CHAR.test(text[a - 1])) a--
  while (b < text.length && WORD_CHAR.test(text[b])) b++
  if (a === b) return null
  const base = $pos.start()
  return { from: base + start + a, to: base + start + b }
}

/**
 * New Comment (Mod-Alt-m): open the composer for the selection, or for the word at a collapsed
 * caret. The thread is created when the composer is submitted (`submitDraft`).
 */
export function newComment(): boolean {
  const v = view()
  if (!v || !v.editable) return false
  const { selection } = v.state
  let range: { from: number; to: number } | null = selection.empty ? wordAt(v.state, selection.head) : { from: selection.from, to: selection.to }
  if (range && v.state.doc.textBetween(range.from, range.to, '', '').trim() === '') range = null
  if (!range) return false
  v.dispatch(v.state.tr.setMeta(commentsKey, { draft: range } satisfies CommentsMeta).setMeta('addToHistory', false))
  actions().setActive(null)
  showComments()
  actions().requestCompose()
  return true
}
commandHooks.newComment = newComment

/** Close the composer without creating a thread. */
export function cancelDraft(): boolean {
  const v = view()
  if (!v || !commentsKey.getState(v.state)?.draft) return false
  v.dispatch(v.state.tr.setMeta(commentsKey, { draft: null } satisfies CommentsMeta).setMeta('addToHistory', false))
  return true
}

/** Create the thread for the open composer: the anchor mark and the thread in one undo step. */
export function submitDraft(text: string): string | null {
  const v = view()
  const draft = v ? commentsKey.getState(v.state)?.draft : null
  const body = cleanText(text)
  if (!v || !draft || !body) return null
  const type = v.state.schema.marks[COMMENT_MARK]
  const id = newCommentId()
  const thread = createThread(id, currentAuthor(), body)
  const tr = v.state.tr.addMark(draft.from, draft.to, type.create({ id }))
  tr.setMeta(commentsKey, { draft: null } satisfies CommentsMeta)
  dispatchThreadChange(v, tr, null, thread, id)
  actions().setActive(id)
  return id
}

function change(threadId: string, fn: (t: CommentThread) => CommentThread | null): boolean {
  const v = view()
  if (!v) return false
  const before = threadsOf(v.state).get(threadId)
  if (!before) return false
  const after = fn(before)
  if (!after) return false
  dispatchThreadChange(v, v.state.tr, before, after, threadId)
  return true
}

export function replyToThread(threadId: string, text: string): boolean {
  const body = cleanText(text)
  return !!body && change(threadId, (t) => withReply(t, currentAuthor(), body))
}

/** Edit a message. Only the author of a message may edit it. */
export function editMessage(threadId: string, messageId: string, text: string): boolean {
  const body = cleanText(text)
  return !!body && change(threadId, (t) => (isOwnMessage(t, messageId) ? withEditedMessage(t, messageId, body) : null))
}

/** Delete a reply (the first message is the comment: use deleteThread). */
export function deleteMessage(threadId: string, messageId: string): boolean {
  return change(threadId, (t) => withoutMessage(t, messageId))
}

export function resolveThread(threadId: string): boolean {
  return change(threadId, (t) => (t.resolved ? null : withResolved(t, true, currentAuthor().name)))
}

export function reopenThread(threadId: string): boolean {
  return change(threadId, (t) => (t.resolved ? withResolved(t, false, currentAuthor().name) : null))
}

/** Delete a thread and its anchor marks (one undo step brings both back). */
export function deleteThread(threadId: string): boolean {
  const v = view()
  if (!v) return false
  const before = threadsOf(v.state).get(threadId)
  if (!before) return false
  const type = v.state.schema.marks[COMMENT_MARK]
  const tr = v.state.tr
  const anchor = collectAnchors(v.state.doc).get(threadId)
  // Only this thread's mark: other comments and every other mark on the text stay.
  if (anchor) tr.removeMark(anchor.from, anchor.to, type.create({ id: threadId }))
  dispatchThreadChange(v, tr, before, null, threadId)
  if (store().comments.activeId === threadId) actions().setActive(null)
  return true
}

export function isOwnMessage(t: CommentThread, messageId: string): boolean {
  return t.messages.find((m) => m.id === messageId)?.author === currentAuthor().name
}

/** The threads shown: anchored in the document, and not resolved unless Show Resolved is on. */
export function shownAnchors(state: EditorState, showResolved = store().comments.showResolved): Anchor[] {
  const threads = threadsOf(state)
  return anchorsInOrder(state.doc).filter((a) => {
    const t = threads.get(a.id)
    return !!t && (showResolved || !t.resolved)
  })
}

/** Select a thread's anchor text, scroll to it and make the thread active. */
export function goToThread(threadId: string, opts: { focus?: boolean } = {}): boolean {
  const v = view()
  if (!v) return false
  const a = collectAnchors(v.state.doc).get(threadId)
  if (!a) return false
  const sel = TextSelection.create(v.state.doc, a.from, a.to)
  v.dispatch(v.state.tr.setSelection(sel).scrollIntoView())
  actions().setActive(threadId)
  if (opts.focus) v.focus()
  centerInView(v, a.from)
  return true
}

/**
 * Scroll the anchor to the middle of the editor region once the pages are drawn, so its spread is the
 * visible one (the margin panel shows the visible spread's comments). A minimal scroll into view could
 * leave the previous spread in the middle of the window.
 */
function centerInView(v: EditorView, pos: number): void {
  requestAnimationFrame(() => {
    if ((v as unknown as { isDestroyed?: boolean }).isDestroyed) return
    let scroller: HTMLElement | null = v.dom.parentElement
    while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement
    if (!scroller) return
    try {
      const c = v.coordsAtPos(Math.min(pos, v.state.doc.content.size), 1)
      const r = scroller.getBoundingClientRect()
      scroller.scrollTop += (c.top + c.bottom) / 2 - (r.top + r.height / 2)
    } catch {
      // No layout (tests): nothing to scroll.
    }
  })
}

function step(dir: 1 | -1): boolean {
  const v = view()
  if (!v) return false
  const list = shownAnchors(v.state)
  if (!list.length) return false
  const active = store().comments.activeId
  const at = list.findIndex((a) => a.id === active)
  let target: Anchor
  if (at >= 0) target = list[(at + dir + list.length) % list.length]
  else {
    const pos = v.state.selection.from
    target = dir > 0 ? (list.find((a) => a.from > pos) ?? list[0]) : ([...list].reverse().find((a) => a.from < pos) ?? list[list.length - 1])
  }
  showComments()
  return goToThread(target.id)
}

/** Next Comment: the next shown thread in document order (wraps). Works in every page view. */
export function nextComment(): boolean {
  return step(1)
}

/** Previous Comment (wraps). */
export function prevComment(): boolean {
  return step(-1)
}

/** View > Comments Panel: show or hide the margin panel (the drawer in a narrow window). */
export function toggleCommentsPanel(): boolean {
  const c = store().comments
  if (narrow) actions().setDrawerOpen(!c.drawerOpen)
  else actions().setPanelOpen(!c.panelOpen)
  return true
}

export function setShowResolved(show: boolean): void {
  actions().setShowResolved(show)
}

export function toggleShowResolved(): boolean {
  setShowResolved(!store().comments.showResolved)
  return true
}

/** Undo / redo in the manuscript (from the panel, where the editor's keymap does not reach). */
export function undoInManuscript(): boolean {
  const v = view()
  return !!v && undo(v.state, v.dispatch)
}
export function redoInManuscript(): boolean {
  const v = view()
  return !!v && redo(v.state, v.dispatch)
}

/** Load threads (a project was opened): replaces them, not undoable, not a change. */
export function loadThreads(threads: readonly CommentThread[]): void {
  const v = view()
  actions().setActive(null)
  if (v) {
    v.dispatch(v.state.tr.setMeta(commentsKey, { load: threads } satisfies CommentsMeta).setMeta('addToHistory', false))
    if (commentsKey.getState(v.state)?.draft) cancelDraft()
  } else {
    actions().threadsChanged(threads, store().comments.version)
  }
}

/** The current threads (the editor's, or the store mirror without an editor). */
export function currentThreads(): readonly CommentThread[] {
  const v = view()
  if (!v) return store().comments.threads
  return sortedThreads(threadsOf(v.state))
}
