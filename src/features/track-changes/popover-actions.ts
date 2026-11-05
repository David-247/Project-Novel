import type { Mark, Node as PMNode } from '@tiptap/pm/model'
import type { EditorView } from '@tiptap/pm/view'
import { TRACKING_MARKS } from '@/shared/track-changes'
import { getMarkupView } from './commands'
import { changeIdAt, listChanges, type TrackedChange } from './review'
import { getReviewView, openChangePopover } from './review-state'

/**
 * The change popover's data and how it opens: a click or tap on a change (ProseMirror's handleClick,
 * which a drag never reaches) or Show Change Details (Alt+Enter) at the caret, in All or Simple
 * Markup only (the other views hide the marks).
 */

export const popoverAllowed = (): boolean => {
  const v = getMarkupView()
  return v === 'all' || v === 'simple'
}

/** Show Change Details: the popover for the change at the caret, with the focus on Accept. */
export function showChangeAtCaret(): boolean {
  const v = getReviewView()
  if (!v || !popoverAllowed()) return false
  const sel = v.state.selection
  const id = changeIdAt(v.state.doc, sel.head) ?? (sel.empty ? null : changeIdAt(v.state.doc, sel.from))
  if (!id) return false
  openChangePopover(id, sel.empty ? sel.head : sel.from, { focus: true })
  return true
}

const INLINE_SELECTOR = '[data-tc-ins],[data-tc-del],[data-tc-fmt]'
const BLOCK_SELECTOR = '[data-tc-block-ins],[data-tc-block-del],[data-tc-style]'

/**
 * The change a click on `target` (inside the manuscript `view`) lands on: the innermost tracked text
 * span, else a changed block clicked outside its text (a break, an empty paragraph, the line's end).
 */
export function changeAtClick(view: EditorView, target: EventTarget | null, pos: number): { id: string; anchor: number } | null {
  if (!(target instanceof Element) || !view.dom.contains(target)) return null
  const span = target.closest(INLINE_SELECTOR)
  if (span && view.dom.contains(span)) {
    const id = span.getAttribute('data-tc-ins') || span.getAttribute('data-tc-del') || span.getAttribute('data-tc-fmt')
    if (id) return { id, anchor: pos }
  }
  const block = target.closest(BLOCK_SELECTOR)
  if (block && view.dom.contains(block)) {
    const id = changeIdAt(view.state.doc, pos)
    if (id) return { id, anchor: pos }
  }
  return null
}

export function openPopoverForClick(view: EditorView, pos: number, event: MouseEvent): boolean {
  if (!popoverAllowed() || event.button !== 0 || event.shiftKey || event.detail > 1) return false
  const hit = changeAtClick(view, event.target, pos)
  if (!hit) return false
  openChangePopover(hit.id, hit.anchor)
  return true
}

// ---- What the popover shows -------------------------------------------------------------------------

export interface ChangeDetails {
  change: TrackedChange
  /** "Inserted", "Deleted", "Formatted", "New paragraph", "Joined paragraphs", "Inserted page break"… */
  kind: string
  /** The changed text (shortened), or '' for a change without text. */
  preview: string
  color: string | null
}

const PREVIEW_CHARS = 80

const hasId = (marks: readonly Mark[], id: string) => marks.some((m) => TRACKING_MARKS.includes(m.type.name) && m.attrs.id === id)
const BREAK_NAMES: Record<string, string> = { pageBreak: 'page break', sceneBreak: 'scene break' }

function kindLabel(doc: PMNode, c: TrackedChange): string {
  const k = new Set(c.kinds)
  const node = doc.nodeAt(c.from)
  const brk = node?.isBlock && node.isLeaf ? (BREAK_NAMES[node.type.name] ?? 'break') : null
  if (k.has('insertion') && k.has('deletion')) return 'Replaced'
  if (k.has('insertion')) return 'Inserted'
  if (k.has('deletion')) return 'Deleted'
  if (k.has('blockInsert')) return brk ? `Inserted ${brk}` : 'New paragraph'
  if (k.has('blockDelete')) return brk ? `Deleted ${brk}` : 'Joined paragraphs'
  if (k.has('formatChange')) return 'Formatted'
  if (k.has('styleChange')) return 'Paragraph formatting changed'
  return 'Changed'
}

/** Author, kind, preview and colour of change `id` in `doc`, or null when it is gone. */
export function describeChange(doc: PMNode, id: string): ChangeDetails | null {
  const change = listChanges(doc).find((c) => c.id === id)
  if (!change) return null
  let text = ''
  let color: string | null = null
  doc.nodesBetween(change.from, change.to, (node) => {
    if (text.length > PREVIEW_CHARS) return false
    const m = node.marks.find((x) => TRACKING_MARKS.includes(x.type.name) && x.attrs.id === id)
    if (m && color === null && typeof m.attrs.authorColor === 'string') color = m.attrs.authorColor
    if (node.isText && hasId(node.marks, id)) text += node.text
    else if (node.isInline && !node.isText && hasId(node.marks, id)) {
      text += node.type.name === 'footnote' ? ` [footnote: ${node.textContent}] ` : ' '
      return false
    }
    return true
  })
  if (!text) {
    // A block change: the start of the block's text.
    const node = doc.nodeAt(change.from)
    if (node?.isTextblock) text = node.textContent
  }
  text = text.replace(/\s+/g, ' ').trim()
  const preview = text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS - 1).trimEnd()}…` : text
  return { change, kind: kindLabel(doc, change), preview, color }
}

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['week', 7 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
]

/** "just now", "5 minutes ago", "yesterday", "3 months ago"; '' for a date that cannot be read. */
export function relativeDate(iso: string, now: number = Date.now()): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const secs = Math.round((t - now) / 1000)
  if (Math.abs(secs) < 60) return 'just now'
  const fmt = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })
  for (const [unit, size] of UNITS) if (Math.abs(secs) >= size) return fmt.format(Math.round(secs / size), unit)
  return 'just now'
}
