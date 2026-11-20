import type { Transaction } from '@tiptap/pm/state'
import { TextSelection } from '@tiptap/pm/state'
import { diffChars } from 'diff'
import { getResolvedStyles, restyleBlock } from '@/features/editor'
import { revealPosition } from '@/features/pagination'
import { lockedInRange, openRewriteWithVersion } from '@/features/rewrite'
import { blockCheckText, textRangeToDoc } from '@/features/spellcheck'
import { useStore } from '@/shared/store'
import type { Correction, ProposedChange } from '../harness/output-tools'
import type { Location, ParagraphIndex } from '../harness/paragraph-index'

/**
 * What the panel does with the tutor's output: corrections (jump, Fix, Ignore) and proposals (the
 * re-write view). Review Focus 2: a correction is only ever applied where its paragraph is now, found
 * by the session's paragraph id (`idx.resolve`) at the moment of the click; an edited paragraph answers
 * 'changed' and the correction can no longer be applied. Text is never searched for elsewhere in the
 * manuscript (that would reopen a way around the guard).
 */

/** "Ch 3 ¶4, line 2"; the front matter (chapter 0) is "Front matter ¶2". */
export function locationLabel(l: Location): string {
  const where = l.chapter > 0 ? `Ch ${l.chapter}` : 'Front matter'
  const para = l.paragraph > 0 ? ` ¶${l.paragraph}` : ''
  return `${where}${para}${l.line ? `, line ${l.line}` : ''}`
}

/** The same, spoken: "Chapter 3, paragraph 4, line 2". */
export function locationSpoken(l: Location): string {
  const parts = [l.chapter > 0 ? `Chapter ${l.chapter}` : 'Front matter']
  if (l.paragraph > 0) parts.push(`paragraph ${l.paragraph}`)
  if (l.line) parts.push(`line ${l.line}`)
  return parts.join(', ')
}

export const CHANGED_REASON = 'This paragraph changed; ask again to refresh.'
export const LOCKED_REASON = 'This passage is in re-write, so change it in the re-write view.'
export const VIEW_OPEN_REASON = 'Close the re-write view first.'
export const SPLIT_REASON = 'The text runs across a tracked change or a footnote, so edit it by hand.'

export type Placement = { ok: true; from: number; to: number } | { ok: false; reason: string }

/** Where the correction's text is in the manuscript now (for jump and Fix), or why it cannot be used. */
export function placeCorrection(idx: ParagraphIndex, c: Pick<Correction, 'paragraphId' | 'original'>): Placement {
  const at = idx.resolve(c.paragraphId)
  if (typeof at !== 'object') return { ok: false, reason: CHANGED_REASON }
  const doc = idx.editor.state.doc
  const node = doc.nodeAt(at.from)
  if (!node?.isTextblock) return { ok: false, reason: CHANGED_REASON }
  // The paragraph is unchanged since the guard checked it (resolve compares the node), so the quoted
  // text is where it was, and only there (list_corrections refuses a quote that occurs twice).
  const { text, segments } = blockCheckText(node, at.from)
  const start = text.indexOf(c.original)
  if (start < 0 || text.indexOf(c.original, start + 1) >= 0) return { ok: false, reason: CHANGED_REASON }
  const range = textRangeToDoc(segments, start, start + c.original.length)
  if (!range) return { ok: false, reason: CHANGED_REASON }
  return { ok: true, ...range }
}

/** Whether Fix may run now: the placement, else the reason it is off (also its tooltip). */
export function fixAvailability(idx: ParagraphIndex, c: Correction): Placement {
  if (c.state !== 'open') return { ok: false, reason: c.state === 'changed' ? CHANGED_REASON : '' }
  if (useStore.getState().rewrite.openId) return { ok: false, reason: VIEW_OPEN_REASON }
  const place = placeCorrection(idx, c)
  if (!place.ok) return place
  if (lockedInRange(idx.editor.state, place.from, place.to)) return { ok: false, reason: LOCKED_REASON }
  // Across hidden content (a tracked deletion, a footnote reference) the range holds more than the text.
  if (place.to - place.from !== c.original.length) return { ok: false, reason: SPLIT_REASON }
  if (!idx.editor.isEditable) return { ok: false, reason: 'The manuscript cannot be edited right now.' }
  return place
}

/** Fix: replace the quoted text with the suggestion (one undoable step; tracked when Track Changes records). */
export function applyCorrection(idx: ParagraphIndex, c: Correction): boolean {
  const place = fixAvailability(idx, c)
  if (!place.ok) return false
  const ed = idx.editor
  ed.view.dispatch(ed.state.tr.insertText(c.suggestion, place.from, place.to).scrollIntoView())
  return true
}

/** Show the correction's text in the manuscript: selected, in view, with the focus. */
export function jumpToCorrection(idx: ParagraphIndex, c: Correction): boolean {
  const place = placeCorrection(idx, c)
  if (!place.ok) return false
  const ed = idx.editor
  ed.view.dispatch(ed.state.tr.setSelection(TextSelection.create(ed.state.doc, place.from, place.to)).scrollIntoView())
  revealPosition(place.from)
  ed.view.focus()
  return true
}

/**
 * Edit paragraph `pos` (in `tr`) from `original` to `revised`, character by character so marks, comments
 * and footnote references outside the changed characters stay. False when the paragraph is no longer
 * `original` or a change would cross hidden content.
 */
function reviseParagraph(tr: Transaction, pos: number, original: string, revised: string): boolean {
  const node = tr.doc.nodeAt(pos)
  if (!node?.isTextblock) return false
  const { text, segments } = blockCheckText(node, pos)
  if (text !== original) return false
  const ops: { start: number; end: number; insert: string }[] = []
  const parts = diffChars(text, revised)
  let off = 0
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]
    if (p.removed) {
      const next = parts[i + 1]
      const insert = next?.added ? next.value : ''
      if (next?.added) i++
      ops.push({ start: off, end: off + p.value.length, insert })
      off += p.value.length
    } else if (p.added) ops.push({ start: off, end: off, insert: p.value })
    else off += p.value.length
  }
  const endPos = () => {
    const last = segments[segments.length - 1]
    return last ? last.pos + last.length : pos + 1
  }
  // From the end, so earlier positions stay valid.
  for (const op of ops.reverse()) {
    if (op.end > op.start) {
      const r = textRangeToDoc(segments, op.start, op.end)
      if (!r || r.to - r.from !== op.end - op.start) return false
      tr.insertText(op.insert, r.from, r.to)
    } else {
      const at = op.start < text.length ? textRangeToDoc(segments, op.start, op.start + 1)?.from : endPos()
      if (at === undefined) return false
      tr.insertText(op.insert, at)
    }
  }
  return true
}

export type ProposalOutcome = { ok: true } | { ok: false; reason: string }

const PROPOSAL_REASONS: Record<'span' | 'locked' | 'open' | 'refused', string> = {
  span: "This suggestion covers more than one chapter, so it can't open side by side. Ask about one chapter at a time.",
  locked: 'Part of this text is already in a re-write. Finish that re-write first.',
  open: 'Close the re-write view first.',
  refused: 'This suggestion no longer fits the text. Ask again to refresh.',
}

/**
 * Open a proposal in the re-write view as the version "Tutor suggestion" (the writer then keeps the
 * original or the suggestion). Every paragraph is found by its id now: one that changed since the
 * guard approved the proposal refuses the whole proposal.
 */
export function openProposal(idx: ParagraphIndex, change: ProposedChange): ProposalOutcome {
  const at: { from: number; to: number; original: string; revised: string }[] = []
  for (let i = 0; i < change.paragraphIds.length; i++) {
    const r = idx.resolve(change.paragraphIds[i])
    if (typeof r !== 'object') return { ok: false, reason: CHANGED_REASON }
    const node = idx.editor.state.doc.nodeAt(r.from)
    if (!node?.isTextblock) return { ok: false, reason: CHANGED_REASON }
    at.push({ ...r, original: blockCheckText(node, r.from).text, revised: change.revisedText[i] })
  }
  if (!at.length) return { ok: false, reason: PROPOSAL_REASONS.refused }
  const style = change.style ? getResolvedStyles().get(change.style) : undefined
  if (change.style && !style) return { ok: false, reason: PROPOSAL_REASONS.refused }
  const range = { from: Math.min(...at.map((p) => p.from)), to: Math.max(...at.map((p) => p.to)) }
  const result = openRewriteWithVersion(
    range,
    (tr) => {
      // From the last paragraph back: an edit never moves the ones before it.
      for (const p of [...at].sort((a, b) => b.from - a.from)) {
        if (p.revised !== p.original && !reviseParagraph(tr, p.from, p.original, p.revised)) return false
        if (style && !restyleBlock(tr, tr.mapping.map(p.from, 1), style)) return false
      }
      return true
    },
    'Tutor suggestion',
  )
  return result.ok ? { ok: true } : { ok: false, reason: PROPOSAL_REASONS[result.reason] }
}
