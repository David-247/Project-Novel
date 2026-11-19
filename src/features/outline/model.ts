import type { Node as PMNode } from '@tiptap/pm/model'
import { blockPlainText, defaultStyleIdFor, effectiveStyleId, getChapters, getResolvedStyles, type Chapter } from '@/features/editor'
import type { ResolvedStyles } from '@/shared/book'
import type { PageInfo } from '@/shared/store'
import { currentMarkupView, isBlockHidden, type MarkupView } from '@/shared/track-changes'

/**
 * The navigation pane's Headings tree (docs/design.md, "Navigation pane"): Front matter, then the
 * chapters (from the editor slice's `getChapters`, so a chapter opens wherever the style sheet and the
 * markup view say it does), each with its subheadings (outline level 2) nested. Pure: derived from the
 * document, the style sheet and the markup view, and cached per document (ProseMirror documents are
 * immutable, so a document seen again is the same object).
 */
export type OutlineKind = 'front' | 'chapter' | 'subheading'

export interface OutlineEntry {
  /** Stable across edits while the entry exists (the tree keeps its expanded state by key). */
  key: string
  kind: OutlineKind
  /** Tree level: 1 for Front matter and chapters, 2 for subheadings. */
  level: 1 | 2
  /** The chapter it belongs to (0-based, as `getChapters`); -1 in front matter. */
  chapterIndex: number
  /** The heading text without footnote text ('' when empty; '' for Front matter). */
  title: string
  /** What the row shows: "Front matter", the title, "Untitled chapter N" or "Untitled subheading". */
  label: string
  /** The 1-based chapter number shown before a chapter title; null for other entries. */
  number: number | null
  /** Document range `[from, to)` (top-level block boundaries); a chapter's includes its subheadings. */
  from: number
  to: number
  children: OutlineEntry[]
}

export interface Outline {
  /** Top level: Front matter (when there is content before the first chapter), then the chapters. */
  entries: OutlineEntry[]
  /** The chapters as `getChapters` returned them (for the counts). */
  chapters: readonly Chapter[]
  /** Every entry in document order (depth first), for lookups. */
  flat: OutlineEntry[]
}

export const FRONT_MATTER_LABEL = 'Front matter'
export const untitledChapter = (n: number) => `Untitled chapter ${n}`
export const UNTITLED_SUBHEADING = 'Untitled subheading'

/** Outline level 2 chapter styles (subheadings) in `styles`. */
function subheadingStyles(styles: ResolvedStyles): ReadonlySet<string> {
  let ids = subMemo.get(styles)
  if (ids) return ids
  ids = new Set([...styles.values()].filter((s) => s.kind === 'chapter' && s.outlineLevel === 2).map((s) => s.id))
  subMemo.set(styles, ids)
  return ids
}
const subMemo = new WeakMap<ResolvedStyles, ReadonlySet<string>>()

const renderedStyle = (node: PMNode, styles: ResolvedStyles) => {
  const id = effectiveStyleId(node)
  return styles.has(id) ? id : defaultStyleIdFor(node.attrs, node.type.name)
}

/** Per document: the last outline built for it (style sheet and markup view as keys). */
const cache = new WeakMap<PMNode, { styles: ResolvedStyles; view: MarkupView; outline: Outline }>()

/**
 * The Headings tree of `doc`. O(top-level blocks) on a new document, O(1) when asked again for the same
 * document, style sheet and markup view (the pane asks on every count publish, page reflow and caret
 * move: getChapters runs once per document version, the deferred item of Wave 1).
 */
export function buildOutline(doc: PMNode, styles: ResolvedStyles = getResolvedStyles(), markupView: MarkupView = currentMarkupView()): Outline {
  const hit = cache.get(doc)
  if (hit && hit.styles === styles && hit.view === markupView) return hit.outline
  const chapters = getChapters(doc, styles, markupView)
  const end = doc.content.size
  const front: OutlineEntry | null =
    (chapters.length === 0 || chapters[0].from > 0) && end > 0
      ? { key: 'front', kind: 'front', level: 1, chapterIndex: -1, title: '', label: FRONT_MATTER_LABEL, number: null, from: 0, to: chapters[0]?.from ?? end, children: [] }
      : null
  const entries: OutlineEntry[] = front ? [front] : []
  for (const c of chapters) {
    entries.push({
      key: `ch:${c.index}`,
      kind: 'chapter',
      level: 1,
      chapterIndex: c.index,
      title: c.title,
      label: c.title.trim() || untitledChapter(c.index + 1),
      number: c.index + 1,
      from: c.from,
      to: c.to,
      children: [],
    })
  }
  // Subheadings: one pass over the top-level blocks, each under the entry it falls in.
  const subs = subheadingStyles(styles)
  if (subs.size && entries.length) {
    let at = 0
    doc.forEach((node, offset) => {
      while (at + 1 < entries.length && entries[at + 1].from <= offset) at++
      const parent = entries[at]
      if (offset < parent.from) return
      if (node.type.name !== 'heading' && node.type.name !== 'paragraph') return
      if (!subs.has(renderedStyle(node, styles))) return
      if (markupView !== 'all' && isBlockHidden(node, markupView)) return
      const title = blockPlainText(node, { markupView })
      parent.children.push({
        key: `${parent.key}/sub:${parent.children.length}`,
        kind: 'subheading',
        level: 2,
        chapterIndex: parent.chapterIndex,
        title,
        label: title.trim() || UNTITLED_SUBHEADING,
        number: null,
        from: offset,
        to: parent.to,
        children: [],
      })
    })
    for (const e of entries) for (let i = 0; i + 1 < e.children.length; i++) e.children[i].to = e.children[i + 1].from
  }
  const flat = entries.flatMap((e) => [e, ...e.children])
  const outline: Outline = { entries, chapters, flat }
  cache.set(doc, { styles, view: markupView, outline })
  return outline
}

/** The deepest entry holding document position `pos` (null when the outline is empty). */
export function entryAt(outline: Outline, pos: number): OutlineEntry | null {
  const end = outline.entries[outline.entries.length - 1]?.to ?? 0
  let found: OutlineEntry | null = null
  // `flat` is in document order: once an entry starts after `pos`, every later one does too.
  for (const e of outline.flat) {
    if (e.from > pos) break
    // The end of the document belongs to the entries that run to it.
    if (pos < e.to || e.to === end) found = e
  }
  return found ?? outline.flat[0] ?? null
}

/** The pages a range `[from, to)` is laid out on, 0-based and inclusive (blank pages skipped), or null. */
export function pageRange(pages: readonly PageInfo[], from: number, to: number): { first: number; last: number } | null {
  if (!pages.length || to <= from) return null
  // First page ending after `from`.
  let lo = 0
  let hi = pages.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (pages[mid].to > from) hi = mid
    else lo = mid + 1
  }
  let first = lo
  while (first < pages.length && pages[first].isBlank) first++
  // Last page starting before `to`.
  lo = 0
  hi = pages.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (pages[mid].from < to) lo = mid + 1
    else hi = mid
  }
  let last = lo - 1
  while (last >= 0 && pages[last].isBlank) last--
  if (first >= pages.length || last < first) return null
  return { first, last }
}

/** "p. 12" or "pp. 12–19" (1-based, as Go to Page and the status bar number the pages). */
export function pageRangeText(range: { first: number; last: number } | null): string {
  if (!range) return ''
  return range.first === range.last ? `p. ${range.first + 1}` : `pp. ${range.first + 1}–${range.last + 1}`
}

/** The same for a screen reader: "page 12" or "pages 12 to 19". */
export function pageRangeSpoken(range: { first: number; last: number } | null): string {
  if (!range) return ''
  return range.first === range.last ? `page ${range.first + 1}` : `pages ${range.first + 1} to ${range.last + 1}`
}
