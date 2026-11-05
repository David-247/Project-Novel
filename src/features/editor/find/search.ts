import { Fragment, Slice, type Mark, type Node as PMNode, type Schema } from '@tiptap/pm/model'
import type { Transaction } from '@tiptap/pm/state'
import { ReplaceStep } from '@tiptap/pm/transform'
import { DELETION_MARK, isBlockHidden, isInlineHidden, TRACKING_MARKS, type MarkupView } from '@/shared/track-changes'

export interface FindOptions {
  caseSensitive: boolean
  wholeWord: boolean
}

/** A match as a document range [from, to). */
export interface MatchRange {
  from: number
  to: number
}

/**
 * Placeholder for inline leaf nodes (hard breaks). It has nodeSize 1, so string offsets inside a
 * textblock equal position offsets, and it can never be part of a plain-text query match.
 */
const LEAF = '￼'

const REGEX_SPECIALS = /[.*+?^${}()|[\]\\/]/g

/**
 * Letters, digits (any script), combining marks and underscore count as word characters for
 * "Whole word". The end boundary is a lookahead in the regex; the start boundary is checked in
 * code (`wordCharBefore`) because regex lookbehind throws on WebKit before Safari 16.4, which
 * older macOS Tauri webviews use.
 */
const WORD_AFTER = '(?![\\p{L}\\p{N}\\p{M}_])'
const WORD_CHAR = /^[\p{L}\p{N}\p{M}_]$/u

/** True when the code point ending just before `index` is a word character (surrogate-aware). */
export function wordCharBefore(text: string, index: number): boolean {
  if (index <= 0) return false
  const low = text.charCodeAt(index - 1)
  let ch = text[index - 1]
  if (low >= 0xdc00 && low <= 0xdfff && index >= 2) {
    const high = text.charCodeAt(index - 2)
    if (high >= 0xd800 && high <= 0xdbff) ch = text.slice(index - 2, index)
  }
  return WORD_CHAR.test(ch)
}

/** UTF-16 length of the code point starting at `index` (1 or 2). */
function codePointLength(text: string, index: number): number {
  const cp = text.codePointAt(index)
  return cp !== undefined && cp > 0xffff ? 2 : 1
}

/**
 * Compile the query to a global regex. The query is literal text (special characters escaped).
 * Case-insensitive matching uses the regex `i` flag rather than lowercasing, so offsets never
 * shift for characters whose case mapping changes length. Returns null for an empty query.
 */
export function buildMatcher(query: string, options: FindOptions): RegExp | null {
  if (query.length === 0) return null
  let source = query.replace(REGEX_SPECIALS, '\\$&')
  if (options.wholeWord) source += WORD_AFTER
  try {
    return new RegExp(source, options.caseSensitive ? 'gu' : 'giu')
  } catch (err) {
    console.error('[find] could not build matcher', err)
    return null
  }
}

/**
 * The text of one textblock with one char per position (inline leaves become LEAF). An inline node
 * with text content (a footnote) becomes LEAF + its text + LEAF: its text is searched, positions
 * stay 1:1 (the note's text starts at the node's position + 1), and a match never spans the
 * reference's boundary (LEAF never matches a typed query).
 */
export function blockText(block: PMNode, markupView: MarkupView = 'all'): string {
  const hidden = (n: PMNode) => markupView !== 'all' && n.marks.length > 0 && isInlineHidden(n, markupView)
  if (block.childCount === 1 && block.firstChild!.isText && !hidden(block.firstChild!)) return block.firstChild!.text!
  let out = ''
  block.forEach((child) => {
    // Text the markup view hides (track changes) is never found: LEAF keeps the positions 1:1.
    if (hidden(child)) out += LEAF.repeat(child.nodeSize)
    else if (child.isText) out += child.text!
    else if (!child.isLeaf && child.inlineContent && child.content.size === child.textContent.length)
      out += LEAF + child.textContent + LEAF
    else out += LEAF.repeat(child.nodeSize)
  })
  return out
}

/**
 * All matches in document order. Searches each textblock's full text (not individual text
 * nodes), so a match may span mark boundaries (e.g. "wor**ld**"). Matches never span two
 * textblocks or a hard break. O(document size) per call. Never throws: an engine error yields [].
 * Track changes: `markupView` (default 'all') skips the text that view hides, so Find in No Markup
 * or Simple Markup never lands on deleted text, and in Original never on inserted text.
 */
export function findMatches(doc: PMNode, query: string, options: FindOptions, markupView: MarkupView = 'all'): MatchRange[] {
  const re = buildMatcher(query, options)
  if (!re) return []
  try {
    return scan(doc, re, options.wholeWord, markupView)
  } catch (err) {
    console.error('[find] search failed', err)
    return []
  }
}

function scan(doc: PMNode, re: RegExp, wholeWord: boolean, markupView: MarkupView): MatchRange[] {
  const out: MatchRange[] = []
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true
    if (node.content.size === 0) return false
    if (markupView !== 'all' && isBlockHidden(node, markupView)) return false
    const text = blockText(node, markupView)
    const start = pos + 1
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      if (m[0].length === 0) {
        re.lastIndex++
        continue
      }
      if (wholeWord && wordCharBefore(text, m.index)) {
        // Rejected start: retry from the next code point (a later, overlapping candidate may fit).
        re.lastIndex = m.index + codePointLength(text, m.index)
        continue
      }
      out.push({ from: start + m.index, to: start + m.index + m[0].length })
    }
    return false
  })
  return out
}

/** Index of the first match whose start is at or after `pos`, wrapping to 0; -1 if none. */
export function indexAtOrAfter(matches: readonly MatchRange[], pos: number): number {
  if (matches.length === 0) return -1
  let lo = 0
  let hi = matches.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (matches[mid].from < pos) lo = mid + 1
    else hi = mid
  }
  return lo < matches.length ? lo : 0
}

/**
 * Marks of the first matched character, so a replacement keeps e.g. bold/italic/font. Track changes
 * marks are not formatting: the replacement never inherits them (the recorder marks it when tracking).
 */
function marksAt(doc: PMNode, from: number): readonly Mark[] {
  const marks = doc.nodeAt(from)?.marks ?? []
  return marks.some((m) => TRACKING_MARKS.includes(m.type.name)) ? marks.filter((m) => !TRACKING_MARKS.includes(m.type.name)) : marks
}

/** Every character of the range is tracked-deleted text (found in All Markup): nothing to replace. */
export function deletedRange(doc: PMNode, range: MatchRange): boolean {
  const type = doc.type.schema.marks[DELETION_MARK]
  if (!type) return false
  let all = true
  doc.nodesBetween(range.from, range.to, (n) => {
    if (n.isInline && !type.isInSet(n.marks)) all = false
    return all
  })
  return all
}

/** Replace one range with literal text in `tr`, keeping the marks of the first matched char. */
export function replaceRange(tr: Transaction, schema: Schema, range: MatchRange, replacement: string): Transaction {
  if (deletedRange(tr.doc, range)) return tr
  return replaceText(tr, schema, range, replacement)
}

/**
 * The replacement step itself. Text in a textblock is one plain ReplaceStep (what tr.replaceWith
 * makes of it, without fitting the slice: Replace All makes one per match); anything else goes
 * through tr.replaceWith / tr.delete.
 */
function replaceText(tr: Transaction, schema: Schema, range: MatchRange, replacement: string): Transaction {
  const content = replacement.length ? Fragment.from(schema.text(replacement, marksAt(tr.doc, range.from))) : Fragment.empty
  if (!tr.maybeStep(new ReplaceStep(range.from, range.to, new Slice(content, 0, 0))).failed) return tr
  return replacement.length ? tr.replaceWith(range.from, range.to, content) : tr.delete(range.from, range.to)
}

/**
 * Replace every range in ONE transaction (one undo step). Ranges must be in document order and
 * non-overlapping; they are applied from last to first so earlier positions never shift. Ranges
 * that are all deleted text are skipped; `replaceable` (one flag per range, from the caller's
 * count) saves checking again.
 */
export function replaceAllRanges(
  tr: Transaction,
  schema: Schema,
  ranges: readonly MatchRange[],
  replacement: string,
  replaceable?: readonly boolean[],
): Transaction {
  for (let i = ranges.length - 1; i >= 0; i--) {
    if (replaceable ? replaceable[i] : !deletedRange(tr.doc, ranges[i])) replaceText(tr, schema, ranges[i], replacement)
  }
  return tr
}
