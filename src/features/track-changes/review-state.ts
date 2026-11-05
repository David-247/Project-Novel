import type { Node as PMNode } from '@tiptap/pm/model'
import type { EditorView } from '@tiptap/pm/view'
import { useSyncExternalStore } from 'react'
import { listAuthors, listChanges } from './review'

/**
 * Review UI state that lives outside the document: the manuscript view the review commands act on,
 * a debounced summary of the changes (count and authors, for the status bar and the by-author
 * commands), and the change popover. Module state with useSyncExternalStore, like the comments slice's
 * view holder: nothing here is saved.
 */

// ---- The manuscript view --------------------------------------------------------------------------

let reviewView: EditorView | null = null

/** Set by the TrackChanges plugin view (the manuscript editor); null on destroy. */
export function setReviewView(view: EditorView | null): void {
  reviewView = view
}

/** The manuscript view, or null (none mounted, or destroyed). */
export function getReviewView(): EditorView | null {
  return reviewView && !(reviewView as unknown as { isDestroyed?: boolean }).isDestroyed ? reviewView : null
}

// ---- Change summary -------------------------------------------------------------------------------

export interface ChangeSummary {
  count: number
  /** Authors of the changes, in document order of first appearance. */
  authors: readonly string[]
}

const EMPTY: ChangeSummary = { count: 0, authors: [] }
let summary: ChangeSummary = EMPTY
let summaryDoc: PMNode | null = null
let timer: ReturnType<typeof setTimeout> | null = null
const summaryListeners = new Set<() => void>()

/** After a document change, the summary is recomputed once typing pauses for this long. */
export const SUMMARY_DEBOUNCE_MS = 200

const sameAuthors = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i])

/** Recompute the summary for `doc` now (a load, an accept / reject). */
export function refreshChangeSummary(doc: PMNode | null): void {
  if (timer !== null) clearTimeout(timer)
  timer = null
  summaryDoc = doc
  const changes = doc ? listChanges(doc) : []
  const next: ChangeSummary = { count: changes.length, authors: listAuthors(changes) }
  if (next.count === summary.count && sameAuthors(next.authors, summary.authors)) return
  summary = next
  summaryListeners.forEach((l) => l())
}

/** Recompute the summary for `doc` once edits pause (typing stays O(1) per keystroke here). */
export function scheduleChangeSummary(doc: PMNode): void {
  if (doc === summaryDoc) return
  summaryDoc = doc
  if (timer !== null) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    const v = getReviewView()
    refreshChangeSummary(v ? v.state.doc : doc)
  }, SUMMARY_DEBOUNCE_MS)
}

export const getChangeSummary = (): ChangeSummary => summary

export function subscribeChangeSummary(cb: () => void): () => void {
  summaryListeners.add(cb)
  return () => summaryListeners.delete(cb)
}

/** React: the change count and authors (debounced while typing). */
export function useChangeSummary(): ChangeSummary {
  return useSyncExternalStore(subscribeChangeSummary, getChangeSummary, getChangeSummary)
}

// ---- Change popover --------------------------------------------------------------------------------

export interface ChangePopoverState {
  /** The change shown. */
  id: string
  /** Document position the popover is anchored at. */
  anchor: number
  /** Opened from the keyboard: the popover takes the focus (a click leaves it in the text). */
  focus: boolean
  /** Bumps on every open (remounts the popover). */
  seq: number
}

let popover: ChangePopoverState | null = null
let seq = 0
const popoverListeners = new Set<() => void>()
const emitPopover = () => popoverListeners.forEach((l) => l())

export function openChangePopover(id: string, anchor: number, opts: { focus?: boolean } = {}): void {
  popover = { id, anchor, focus: opts.focus === true, seq: ++seq }
  emitPopover()
}

export function closeChangePopover(): void {
  if (!popover) return
  popover = null
  emitPopover()
}

export const getChangePopover = (): ChangePopoverState | null => popover

export function subscribeChangePopover(cb: () => void): () => void {
  popoverListeners.add(cb)
  return () => popoverListeners.delete(cb)
}

export function useChangePopover(): ChangePopoverState | null {
  return useSyncExternalStore(subscribeChangePopover, getChangePopover, getChangePopover)
}

/** Test-only. */
export function __resetReviewStateForTests(): void {
  if (timer !== null) clearTimeout(timer)
  timer = null
  summary = EMPTY
  summaryDoc = null
  popover = null
  reviewView = null
}
