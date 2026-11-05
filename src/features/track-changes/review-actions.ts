import type { Node as PMNode } from '@tiptap/pm/model'
import { NodeSelection, Selection, TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import {
  acceptAll,
  acceptAllByAuthor,
  acceptChange,
  acceptChangesInRange,
  changeIdAt,
  listChanges,
  rejectAll,
  rejectAllByAuthor,
  rejectChange,
  rejectChangesInRange,
  type TrackedChange,
} from './review'
import { closeChangePopover, getReviewView, refreshChangeSummary } from './review-state'

/**
 * The review commands as plain functions (docs/track-changes.md, "Review"): Next / Previous Change,
 * Accept / Reject at the caret or the selection (and Move to Next), Accept / Reject All (optionally by
 * one author, with a confirmation above CONFIRM_ABOVE changes). Each accept / reject is one
 * transaction (one undo step, never recorded as a change: TRACK_SKIP_META on the core's
 * transactions). They act on the manuscript view (`getReviewView`) and return false when they did
 * nothing.
 */

export type ReviewMode = 'accept' | 'reject'

/** Accept All / Reject All ask first when they would resolve more changes than this. */
export const CONFIRM_ABOVE = 50

// ---- Reveal (page navigation) ---------------------------------------------------------------------

/**
 * Brings document position `pos` of `view` into sight once the selection is set. Default: scroll the
 * pages so the position is in the middle of the editor region (both the spread and the single-page
 * view scroll). The composition root can swap it for the pagination slice's reveal (page-turn view).
 */
export type ChangeRevealer = (view: EditorView, pos: number) => void

const scrollToMiddle: ChangeRevealer = (view, pos) => {
  requestAnimationFrame(() => {
    if ((view as unknown as { isDestroyed?: boolean }).isDestroyed) return
    let scroller: HTMLElement | null = view.dom.parentElement
    while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement
    if (!scroller) return
    try {
      const c = view.coordsAtPos(Math.min(pos, view.state.doc.content.size), 1)
      const r = scroller.getBoundingClientRect()
      scroller.scrollTop += (c.top + c.bottom) / 2 - (r.top + r.height / 2)
    } catch {
      // No layout (tests): nothing to scroll.
    }
  })
}

let revealer: ChangeRevealer = scrollToMiddle
/** Replace how a change is brought into sight (null restores the scroll default). */
export function setChangeRevealer(fn: ChangeRevealer | null): void {
  revealer = fn ?? scrollToMiddle
}

// ---- Confirmation -----------------------------------------------------------------------------------

export interface ReviewConfirmRequest {
  title: string
  message: string
  /** Label of the button that goes ahead ("Accept All"). */
  confirmLabel: string
}
export type ReviewConfirm = (req: ReviewConfirmRequest) => Promise<boolean>

const windowConfirm: ReviewConfirm = async ({ message }) => {
  try {
    return window.confirm(message)
  } catch {
    return false
  }
}
let confirmFn: ReviewConfirm = windowConfirm
/** The dialog Accept All / Reject All ask with (the composition root: the app's native message dialog). */
export function setReviewConfirm(fn: ReviewConfirm | null): void {
  confirmFn = fn ?? windowConfirm
}

// ---- Navigation -------------------------------------------------------------------------------------

const INLINE_KINDS = new Set(['insertion', 'deletion', 'formatChange'])

/** Where Next / Previous Change puts the selection for `c`. */
function selectionFor(doc: PMNode, c: TrackedChange): Selection {
  const node = doc.nodeAt(c.from)
  if (node?.isBlock && node.isLeaf && c.to === c.from + node.nodeSize) return NodeSelection.create(doc, c.from)
  if (c.kinds.some((k) => INLINE_KINDS.has(k))) {
    // The changed text (from its first to its last inline position).
    const a = Selection.findFrom(doc.resolve(c.from), 1, true)
    const b = Selection.findFrom(doc.resolve(c.to), -1, true)
    if (a && b && b.to > a.from) return TextSelection.create(doc, a.from, b.to)
  }
  // A paragraph boundary or style change: the caret at the start of the block.
  return Selection.findFrom(doc.resolve(Math.min(c.from + (node?.isTextblock ? 1 : 0), doc.content.size)), 1, true) ?? Selection.near(doc.resolve(c.from))
}

/** The change Next / Previous Change last selected, while its selection is unchanged. */
let visited: { id: string; anchor: number; head: number; doc: PMNode } | null = null

function visitedId(state: EditorState): string | null {
  if (!visited || visited.doc !== state.doc) return null
  const s = state.selection
  return s.anchor === visited.anchor && s.head === visited.head ? visited.id : null
}

/** Changes in the order Next Change visits them, with the selection each one gets. */
function navigationList(doc: PMNode): { c: TrackedChange; sel: Selection }[] {
  return listChanges(doc)
    .map((c) => ({ c, sel: selectionFor(doc, c) }))
    .sort((x, y) => x.sel.from - y.sel.from || x.c.from - y.c.from)
}

function goTo(view: EditorView, c: TrackedChange, sel: Selection): void {
  view.dispatch(view.state.tr.setSelection(sel).scrollIntoView())
  visited = { id: c.id, anchor: view.state.selection.anchor, head: view.state.selection.head, doc: view.state.doc }
  view.focus()
  revealer(view, sel.from)
}

function step(dir: 1 | -1): boolean {
  const v = getReviewView()
  if (!v) return false
  const list = navigationList(v.state.doc)
  if (!list.length) return false
  closeChangePopover()
  const current = visitedId(v.state)
  const at = current ? list.findIndex((x) => x.c.id === current) : -1
  let target
  if (at >= 0) target = list[(at + dir + list.length) % list.length]
  else {
    const pos = v.state.selection.from
    target = dir > 0 ? (list.find((x) => x.sel.from > pos) ?? list[0]) : ([...list].reverse().find((x) => x.sel.from < pos) ?? list[list.length - 1])
  }
  goTo(v, target.c, target.sel)
  return true
}

/** Next Change: the next change after the selection (wraps), selected and scrolled into view. */
export const nextChange = (): boolean => step(1)
/** Previous Change (wraps). */
export const prevChange = (): boolean => step(-1)

// ---- Accept / reject ----------------------------------------------------------------------------------

function dispatchResolved(view: EditorView, tr: Transaction | null, scroll = true): boolean {
  if (!tr) return false
  closeChangePopover()
  view.dispatch(scroll ? tr.scrollIntoView() : tr)
  refreshChangeSummary(view.state.doc)
  return true
}

/**
 * The change(s) Accept / Reject act on: the change Next Change selected, else the change at a
 * collapsed caret, else every change touching the selection.
 */
export function resolveAtSelection(state: EditorState, mode: ReviewMode): Transaction | null {
  const id = visitedId(state) ?? (state.selection.empty ? changeIdAt(state.doc, state.selection.head) : null)
  if (id) return mode === 'accept' ? acceptChange(state, id) : rejectChange(state, id)
  if (state.selection.empty) return null
  const { from, to } = state.selection
  return mode === 'accept' ? acceptChangesInRange(state, from, to) : rejectChangesInRange(state, from, to)
}

/** Accept (Reject): the change at the caret, or every change in the selection. */
export function resolveSelection(mode: ReviewMode): boolean {
  const v = getReviewView()
  if (!v) return false
  const done = dispatchResolved(v, resolveAtSelection(v.state, mode))
  if (done) v.focus()
  return done
}

/** Accept (Reject) and Move to Next: resolve what is at the selection, then go to the next change. */
export function resolveAndNext(mode: ReviewMode): boolean {
  const v = getReviewView()
  if (!v) return false
  const done = dispatchResolved(v, resolveAtSelection(v.state, mode))
  visited = null
  const moved = nextChange()
  if (!moved) v.focus()
  return done || moved
}

/** Accept (Reject) one change by id (the change popover). */
export function resolveChange(id: string, mode: ReviewMode): boolean {
  const v = getReviewView()
  if (!v) return false
  const done = dispatchResolved(v, mode === 'accept' ? acceptChange(v.state, id) : rejectChange(v.state, id))
  v.focus()
  return done
}

const plural = (n: number) => `${n.toLocaleString()} ${n === 1 ? 'change' : 'changes'}`

/**
 * Accept All / Reject All (of `author` when given): one transaction, one undo step. Asks first above
 * CONFIRM_ABOVE changes. Resolves true when it changed the document.
 */
export async function resolveAll(mode: ReviewMode, author?: string): Promise<boolean> {
  const v = getReviewView()
  if (!v) return false
  closeChangePopover()
  const n = listChanges(v.state.doc).filter((c) => author === undefined || c.author === author).length
  if (n === 0) return false
  if (n > CONFIRM_ABOVE) {
    const verb = mode === 'accept' ? 'Accept' : 'Reject'
    const who = author === undefined ? '' : ` by ${author}`
    const ok = await confirmFn({
      title: `${verb} all changes${who}?`,
      message:
        mode === 'accept'
          ? `This accepts ${plural(n)}${who}: inserted text stays, deleted text goes. You can undo it in one step.`
          : `This rejects ${plural(n)}${who}: inserted text goes, deleted text comes back. You can undo it in one step.`,
      confirmLabel: author === undefined ? `${verb} All` : `${verb} All by ${author}`,
    }).catch(() => false)
    if (!ok) return false
  }
  const view = getReviewView()
  if (!view) return false
  const s = view.state
  const tr = author === undefined ? (mode === 'accept' ? acceptAll(s) : rejectAll(s)) : mode === 'accept' ? acceptAllByAuthor(s, author) : rejectAllByAuthor(s, author)
  const done = dispatchResolved(view, tr, false)
  view.focus()
  return done
}

/** Test-only. */
export function __resetReviewActionsForTests(): void {
  visited = null
  revealer = scrollToMiddle
  confirmFn = windowConfirm
}
