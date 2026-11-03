import type { Mark, Node as PMNode, Schema } from '@tiptap/pm/model'
import type { Transaction } from '@tiptap/pm/state'

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

/** Letters, digits (any script) and underscore count as word characters for "Whole word". */
const WORD_BEFORE = '(?<![\\p{L}\\p{N}\\p{M}_])'
const WORD_AFTER = '(?![\\p{L}\\p{N}\\p{M}_])'

/**
 * Compile the query to a global regex. The query is literal text (special characters escaped).
 * Case-insensitive matching uses the regex `i` flag rather than lowercasing, so offsets never
 * shift for characters whose case mapping changes length. Returns null for an empty query.
 */
export function buildMatcher(query: string, options: FindOptions): RegExp | null {
  if (query.length === 0) return null
  let source = query.replace(REGEX_SPECIALS, '\\$&')
  if (options.wholeWord) source = WORD_BEFORE + source + WORD_AFTER
  return new RegExp(source, options.caseSensitive ? 'gu' : 'giu')
}

/** The text of one textblock with one char per position (inline leaves become LEAF). */
function blockText(block: PMNode): string {
  if (block.childCount === 1 && block.firstChild!.isText) return block.firstChild!.text!
  let out = ''
  block.forEach((child) => {
    out += child.isText ? child.text! : LEAF.repeat(child.nodeSize)
  })
  return out
}

/**
 * All matches in document order. Searches each textblock's full text (not individual text
 * nodes), so a match may span mark boundaries (e.g. "wor**ld**"). Matches never span two
 * textblocks or a hard break. O(document size) per call.
 */
export function findMatches(doc: PMNode, query: string, options: FindOptions): MatchRange[] {
  const re = buildMatcher(query, options)
  if (!re) return []
  const out: MatchRange[] = []
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true
    if (node.content.size === 0) return false
    const text = blockText(node)
    const start = pos + 1
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      if (m[0].length === 0) {
        re.lastIndex++
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

/** Marks of the first matched character, so a replacement keeps e.g. bold/italic/font. */
function marksAt(doc: PMNode, from: number): readonly Mark[] {
  return doc.nodeAt(from)?.marks ?? []
}

/** Replace one range with literal text in `tr`, keeping the marks of the first matched char. */
export function replaceRange(tr: Transaction, schema: Schema, range: MatchRange, replacement: string): Transaction {
  if (replacement.length === 0) return tr.delete(range.from, range.to)
  const marks = marksAt(tr.doc, range.from)
  return tr.replaceWith(range.from, range.to, schema.text(replacement, marks))
}

/**
 * Replace every range in ONE transaction (one undo step). Ranges must be in document order and
 * non-overlapping; they are applied from last to first so earlier positions never shift.
 */
export function replaceAllRanges(
  tr: Transaction,
  schema: Schema,
  ranges: readonly MatchRange[],
  replacement: string,
): Transaction {
  for (let i = ranges.length - 1; i >= 0; i--) replaceRange(tr, schema, ranges[i], replacement)
  return tr
}
