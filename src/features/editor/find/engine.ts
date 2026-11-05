import type { Editor } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import { closeHistory } from '@tiptap/pm/history'
import { NodeSelection, TextSelection } from '@tiptap/pm/state'
import type { EditorState, Transaction } from '@tiptap/pm/state'
import type { DecorationSet } from '@tiptap/pm/view'
import { useStore } from '@/shared/store'
import { currentMarkupView, type MarkupView } from '@/shared/track-changes'
import { getEditor, subscribeEditor } from '../controller'
import { FOOTNOTE_NODE } from '../footnote/name'
import {
  buildCurrentDecoration,
  buildMatchDecorations,
  clearFindDecorations,
  CURRENT_CLASS,
  findMatchesKey,
  matchDecoration,
  noteAround,
  setFindDecorations,
} from './plugin'
import { deletedRange, findMatches, indexAtOrAfter, replaceAllRanges, replaceRange } from './search'
import type { FindOptions, MatchRange } from './search'

/**
 * Find engine: owns the match list (document positions never enter the store) and keeps
 * the ProseMirror decorations and the store counters in sync.
 *
 * Performance (100k-word budget):
 * - Only runs while the panel is open (`startFindEngine` is called by the panel on open and
 *   stopped on close, which also clears highlights). Closed panel = zero per-keystroke work.
 * - Query/option changes re-scan after QUERY_DEBOUNCE_MS; document edits only map the existing
 *   decorations (cheap) and re-scan after DOC_DEBOUNCE_MS of quiet.
 * - Explicit actions (next/previous/replace) re-scan synchronously only if the doc or query
 *   changed since the last scan (checked by doc identity, O(1)).
 */

export const QUERY_DEBOUNCE_MS = 120
export const DOC_DEBOUNCE_MS = 250
/** Longest selection that pre-fills the query on Mod-f. */
const MAX_PREFILL = 200
/**
 * Matches highlighted on each side of the current one. Scanning is cheap (~10 ms for 60k
 * matches in 100k words) but every highlight is a DOM span, so a very common query ("e") would
 * otherwise create tens of thousands of them. The count in the panel is always exact; the
 * highlight window slides when navigation leaves it.
 */
export const HIGHLIGHT_WINDOW = 1000

let matches: MatchRange[] = []
let current = -1
let scannedDoc: PMNode | null = null
let scannedKey = ''
let winStart = 0
let winEnd = 0
let timer: ReturnType<typeof setTimeout> | null = null
let running = false

function findState() {
  return useStore.getState().find
}

function searchParams(): { query: string; options: FindOptions; key: string; markupView: MarkupView } {
  const f = findState()
  const options = { caseSensitive: f.caseSensitive, wholeWord: f.wholeWord }
  const markupView = currentMarkupView()
  return { query: f.query, options, markupView, key: `${f.caseSensitive ? 1 : 0}${f.wholeWord ? 1 : 0}${markupView}:${f.query}` }
}

function publish() {
  useStore.getState().findActions.setResults(matches.length, current)
}

function clearTimer() {
  if (timer !== null) {
    clearTimeout(timer)
    timer = null
  }
}

function isFresh(ed: Editor): boolean {
  return scannedDoc === ed.state.doc && scannedKey === searchParams().key
}

interface ScanOptions {
  /** Current match = first match starting at/after this position (default: selection start). */
  anchor?: number
  /** Select and scroll to the current match (query changes, explicit navigation). */
  reveal?: boolean
  /** Close the undo group so later typing is not merged into a preceding replace. */
  closeUndoGroup?: boolean
}

/** Scan the whole document now and refresh highlights + counters. */
export function scanNow(opts: ScanOptions = {}): void {
  clearTimer()
  const ed = getEditor()
  if (!ed) {
    matches = []
    current = -1
    scannedDoc = null
    publish()
    return
  }
  const { query, options, key, markupView } = searchParams()
  const state = ed.state
  matches = findMatches(state.doc, query, options, markupView)
  scannedDoc = state.doc
  scannedKey = key
  current = indexAtOrAfter(matches, opts.anchor ?? state.selection.from)
  const tr = setFindDecorations(state.tr, {
    matches: windowDecorations(state, false),
    current: buildCurrentDecoration(state, matches[current]),
  })
  if (opts.closeUndoGroup) closeHistory(tr)
  const reveal = opts.reveal && current >= 0
  if (reveal) selectMatch(tr, matches[current])
  ed.view.dispatch(tr)
  if (reveal) revealCurrent(ed)
  publish()
}

/**
 * Decorations for the highlight window around `current`, or undefined when the highlighted
 * ranges already on screen (mapped through edits) are identical, so a re-scan after typing that
 * did not add/remove a match costs no DOM work.
 */
function windowDecorations(state: EditorState, force: boolean): DecorationSet | undefined {
  const c = Math.max(current, 0)
  winStart = Math.max(0, c - HIGHLIGHT_WINDOW)
  winEnd = Math.min(matches.length, c + HIGHLIGHT_WINDOW + 1)
  const slice = matches.slice(winStart, winEnd)
  if (!force) {
    const shown = findMatchesKey.getState(state)?.find() ?? []
    if (shown.length === slice.length) {
      shown.sort((a, b) => a.from - b.from)
      const drawn = slice.map((m) => matchDecoration(state, m, {}))
      if (shown.every((d, i) => d.from === drawn[i].from && d.to === drawn[i].to)) return undefined
    }
  }
  return buildMatchDecorations(state, slice)
}

function selectMatch(tr: Transaction, m: MatchRange) {
  // A match inside a footnote: its text is not in the line, so the reference is selected.
  const note = noteAround(tr.doc, m.from)
  tr.setSelection(note ? NodeSelection.create(tr.doc, note[0]) : TextSelection.create(tr.doc, m.from, m.to)).scrollIntoView()
}

let beforeReveal: (() => void) | null = null

/**
 * Hook run before the find panel scrolls the current match into view by its DOM position. A host
 * that lays the editor out (pagination) uses it to finish pending layout work first, so the match is
 * where it is painted. One hook; `null` removes it.
 */
export function setFindRevealHook(hook: (() => void) | null): void {
  beforeReveal = hook
}

/**
 * ProseMirror only scrolls to the selection when the DOM selection is inside the editor, which
 * is not the case while typing in the find field, so scroll the current highlight ourselves.
 */
function revealCurrent(ed: Editor) {
  beforeReveal?.()
  const el = ed.view.dom.querySelector(`.${CURRENT_CLASS}`)
  if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'center', inline: 'nearest' })
}

function scheduleScan(delay: number, opts: ScanOptions = {}) {
  clearTimer()
  timer = setTimeout(() => {
    timer = null
    const ed = getEditor()
    if (ed && isFresh(ed)) return
    // Never touch decorations mid-IME-composition; try again once it settles.
    if (ed?.view.composing) {
      scheduleScan(delay, opts)
      return
    }
    scanNow(opts)
  }, delay)
}

/** Make the current match `index`: move the "current" highlight, select it and scroll to it. */
function goTo(ed: Editor, index: number) {
  current = index
  const m = matches[index]
  const slide = index < winStart || index >= winEnd
  const tr = setFindDecorations(ed.state.tr, {
    current: buildCurrentDecoration(ed.state, m),
    matches: slide ? windowDecorations(ed.state, true) : undefined,
  })
  if (m) selectMatch(tr, m)
  ed.view.dispatch(tr)
  if (m) revealCurrent(ed)
  publish()
}

function sameRange(a: MatchRange | undefined, from: number, to: number) {
  return !!a && a.from === from && a.to === to
}

/** Move to the next match (wraps). Bound to Enter in the find field. */
export function findNext(): void {
  const ed = getEditor()
  if (!ed) return
  if (!isFresh(ed)) {
    scanNow()
    const { from, to } = ed.state.selection
    if (matches.length === 0) return
    // Rescanned: the current match is at/after the caret. Skip it if it is the selection itself.
    let i = current
    if (sameRange(matches[i], from, to)) i = (i + 1) % matches.length
    goTo(ed, i)
    return
  }
  if (matches.length === 0) return
  goTo(ed, current < 0 ? 0 : (current + 1) % matches.length)
}

/** Move to the previous match (wraps). Bound to Shift+Enter in the find field. */
export function findPrevious(): void {
  const ed = getEditor()
  if (!ed) return
  if (!isFresh(ed)) {
    scanNow()
    if (matches.length === 0) return
    const from = ed.state.selection.from
    let i = indexAtOrAfter(matches, from)
    // indexAtOrAfter wraps to 0; the previous match is the one just before the caret.
    i = matches[i].from >= from ? i - 1 : matches.length - 1
    goTo(ed, i < 0 ? matches.length - 1 : i)
    return
  }
  if (matches.length === 0) return
  goTo(ed, current <= 0 ? matches.length - 1 : current - 1)
}

/**
 * Replace the current match, then move to the next one. Returns true if something was replaced.
 * Each Replace is its own undo step (history is closed before and after), so undo walks back
 * one replacement at a time; Replace All is a single step.
 */
export function replaceCurrent(): boolean {
  const ed = getEditor()
  if (!ed) return false
  if (!isFresh(ed)) scanNow()
  // Track changes: a match that is all deleted text (found in All Markup) cannot be replaced.
  const at = replaceableFrom(ed.state.doc, current)
  const m = matches[at]
  if (!m) return false
  const replacement = findState().replacement
  const tr = replaceRange(ed.state.tr, ed.schema, m, replacement)
  closeHistory(clearFindDecorations(tr))
  ed.view.dispatch(tr)
  scanNow({ anchor: m.from + replacement.length, closeUndoGroup: true })
  // With Track Changes on the replaced text stays (deleted): go on past it, to a match still there.
  const next = replaceableFrom(ed.state.doc, current)
  if (next >= 0) goTo(ed, next)
  else if (current >= 0) goTo(ed, current)
  return true
}

/** The first match at or after `index` (wrapping) that is not all deleted text; -1 when none is. */
function replaceableFrom(doc: PMNode, index: number): number {
  if (index < 0 || matches.length === 0) return -1
  for (let k = 0; k < matches.length; k++) {
    const i = (index + k) % matches.length
    if (!deletedRange(doc, matches[i])) return i
  }
  return -1
}

/**
 * Replace every match in a single transaction (one undo step restores all of them).
 * Returns the number of replacements (matches that are all deleted text are skipped).
 */
export function replaceAll(): number {
  const ed = getEditor()
  if (!ed) return 0
  if (!isFresh(ed)) scanNow()
  const doc = ed.state.doc
  const replaceable = matches.map((m) => !deletedRange(doc, m))
  const count = replaceable.filter(Boolean).length
  if (count === 0) return 0
  const tr = replaceAllRanges(ed.state.tr, ed.schema, matches, findState().replacement, replaceable)
  closeHistory(clearFindDecorations(tr))
  ed.view.dispatch(tr)
  scanNow({ closeUndoGroup: true })
  return count
}

/** Snapshot of the current matches (tests / diagnostics). */
export function getMatches(): readonly MatchRange[] {
  return matches
}

function clearHighlights() {
  clearTimer()
  matches = []
  current = -1
  scannedDoc = null
  scannedKey = ''
  winStart = winEnd = 0
  const ed = getEditor()
  if (ed) {
    const empty = buildMatchDecorations(ed.state, [])
    ed.view.dispatch(setFindDecorations(ed.state.tr, { matches: empty, current: empty }))
  }
}

/**
 * Start scanning (called when the panel opens). Scans immediately, then follows query/option
 * changes (debounced), document changes (debounced) and editor mount. Returns stop, which
 * clears all highlights and timers.
 */
export function startFindEngine(): () => void {
  running = true
  scanNow({ reveal: findState().query.length > 0 })
  const unsubStore = useStore.subscribe((s, prev) => {
    if (!running) return
    const f = s.find
    const p = prev.find
    if (f.query !== p.query || f.caseSensitive !== p.caseSensitive || f.wholeWord !== p.wholeWord) {
      scheduleScan(QUERY_DEBOUNCE_MS, { reveal: true })
    } else if (s.editor.docVersion !== prev.editor.docVersion) {
      scheduleScan(DOC_DEBOUNCE_MS)
    } else if (s.trackChanges.markupView !== prev.trackChanges.markupView) {
      // Track changes: what can be found follows the markup view.
      scheduleScan(0)
    }
  })
  const unsubEditor = subscribeEditor(() => {
    if (running) scheduleScan(0)
  })
  return () => {
    running = false
    unsubStore()
    unsubEditor()
    clearHighlights()
    publish()
  }
}

/**
 * Open (or re-focus) the panel, pre-filling the query from a short single-block selection unless
 * `prefill` is false (Mod-f pressed while focus is already in the panel).
 */
export function openFind({ prefill: usePrefill = true }: { prefill?: boolean } = {}): void {
  const ed = getEditor()
  let prefill: string | undefined
  if (ed && usePrefill) {
    const { from, to, $from, $to, empty } = ed.state.selection
    // A selection holding a footnote reference is not prefilled: textBetween would run the note text
    // into the sentence, and a match never spans a reference anyway (search.ts blockText).
    // Cheap checks first; the note scan only runs on a short single-block selection.
    let hasNote = false
    const short = !empty && $from.sameParent($to) && to - from <= MAX_PREFILL
    if (short) ed.state.doc.nodesBetween(from, to, (n) => !(hasNote ||= n.type.name === FOOTNOTE_NODE))
    if (short && !hasNote) {
      const text = ed.state.doc.textBetween(from, to, '\n', '\n')
      if (text.trim().length > 0 && !text.includes('\n')) prefill = text
    }
  }
  useStore.getState().findActions.openPanel(prefill)
}

/** Close the panel (stops the engine via the panel) and optionally return focus to the editor. */
export function closeFind({ focusEditor = true }: { focusEditor?: boolean } = {}): void {
  useStore.getState().findActions.closePanel()
  if (focusEditor) getEditor()?.commands.focus()
}
