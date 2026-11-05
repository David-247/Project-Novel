import { diffWordsWithSpace } from 'diff'
import type { Node as PMNode } from '@tiptap/pm/model'

/**
 * Comparison of the original passage with a revision (pure; docs/design.md, "Re-write").
 *
 * - Paragraph alignment: a global alignment (Needleman-Wunsch) of the two block lists that maximizes
 *   the summed word similarity of the paired blocks. Blocks too different to pair (below
 *   MIN_SIMILARITY) are left unpaired, so an inserted or removed paragraph leaves a gap on the other
 *   page instead of pushing every later pair out of line.
 * - Word diff of each pair: jsdiff's `diffWordsWithSpace` (BSD-3-Clause) on the blocks' text, mapped
 *   back to document positions.
 */

/** Two blocks pair when at least this share of their words is common (Dice coefficient). */
export const MIN_SIMILARITY = 0.3

/** One row of the aligned comparison: block indices (top-level) on each side, null for a gap. */
export interface AlignedRow {
  left: number | null
  right: number | null
  /** same: identical text; changed: paired but different; removed / added: one side only. */
  kind: 'same' | 'changed' | 'removed' | 'added'
}

/** A block's text and, for each character, its document position (relative to the block's content start). */
export interface BlockText {
  text: string
  /** Position (relative to the block's start + 1) of character i. */
  pos: number[]
  /** Size in the document of character i (1 for text; an inline atom's nodeSize). */
  size: number[]
}

const textCache = new WeakMap<PMNode, BlockText>()

/**
 * The comparable text of a top-level block. Textblocks: their inline content, an inline atom
 * (footnote reference, hard break) counting as one character. Other blocks (lists, breaks): their
 * text content, without positions (compared as a whole).
 */
export function blockText(block: PMNode): BlockText {
  let t = textCache.get(block)
  if (t) return t
  const pos: number[] = []
  const size: number[] = []
  let text = ''
  if (block.isTextblock) {
    block.forEach((child, offset) => {
      if (child.isText) {
        const s = child.text ?? ''
        for (let i = 0; i < s.length; i++) {
          pos.push(offset + i)
          size.push(1)
        }
        text += s
      } else {
        // Footnote reference or hard break: one unit (never split by the diff).
        text += child.type.name === 'hardBreak' ? '\n' : '￼'
        pos.push(offset)
        size.push(child.nodeSize)
      }
    })
  } else {
    text = block.isLeaf ? `\u0000${block.type.name}` : block.textContent
  }
  t = { text, pos, size }
  textCache.set(block, t)
  return t
}

const wordsCache = new WeakMap<PMNode, Map<string, number>>()

function wordCounts(block: PMNode): Map<string, number> {
  let m = wordsCache.get(block)
  if (m) return m
  m = new Map()
  for (const w of blockText(block).text.toLowerCase().split(/[\s￼]+/)) {
    const k = w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
    if (k) m.set(k, (m.get(k) ?? 0) + 1)
  }
  wordsCache.set(block, m)
  return m
}

/** Word similarity of two blocks in [0, 1] (Dice coefficient over word multisets). */
export function similarity(a: PMNode, b: PMNode): number {
  if (a.type !== b.type && (a.isTextblock !== b.isTextblock || !a.isTextblock)) return 0
  const ta = blockText(a).text
  const tb = blockText(b).text
  if (ta === tb) return 1
  const wa = wordCounts(a)
  const wb = wordCounts(b)
  let na = 0
  let nb = 0
  wa.forEach((c) => (na += c))
  wb.forEach((c) => (nb += c))
  if (na === 0 || nb === 0) return na === nb ? 0.5 : 0
  const [small, big] = wa.size <= wb.size ? [wa, wb] : [wb, wa]
  let common = 0
  small.forEach((c, w) => (common += Math.min(c, big.get(w) ?? 0)))
  return (2 * common) / (na + nb)
}

function children(doc: PMNode): PMNode[] {
  const out: PMNode[] = []
  doc.forEach((n) => out.push(n))
  return out
}

/** Align the top-level blocks of two passage docs (see the module comment). O(n·m). */
export function alignBlocks(left: PMNode, right: PMNode): AlignedRow[] {
  const a = children(left)
  const b = children(right)
  const n = a.length
  const m = b.length
  // score[i][j]: best total for a[i..], b[j..] (suffix form, so the walk below goes forward).
  const W = m + 1
  const score = new Float64Array((n + 1) * W)
  const sim = new Float64Array(n * m)
  for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) sim[i * m + j] = similarity(a[i], b[j])
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const s = sim[i * m + j]
      const pair = s >= MIN_SIMILARITY ? s + score[(i + 1) * W + j + 1] : -1
      score[i * W + j] = Math.max(pair, score[(i + 1) * W + j], score[i * W + j + 1])
    }
  }
  const rows: AlignedRow[] = []
  let i = 0
  let j = 0
  const EPS = 1e-9
  while (i < n || j < m) {
    if (i < n && j < m) {
      const s = sim[i * m + j]
      const here = score[i * W + j]
      if (s >= MIN_SIMILARITY && Math.abs(here - (s + score[(i + 1) * W + j + 1])) < EPS) {
        rows.push({ left: i, right: j, kind: blockText(a[i]).text === blockText(b[j]).text && a[i].sameMarkup(b[j]) ? 'same' : 'changed' })
        i++
        j++
        continue
      }
      // Removed blocks first, then added ones (a replaced paragraph reads top to bottom).
      if (Math.abs(here - score[(i + 1) * W + j]) < EPS) {
        rows.push({ left: i++, right: null, kind: 'removed' })
        continue
      }
      rows.push({ left: null, right: j++, kind: 'added' })
      continue
    }
    if (i < n) rows.push({ left: i++, right: null, kind: 'removed' })
    else rows.push({ left: null, right: j++, kind: 'added' })
  }
  // Identical block content but different formatting counts as a change only when the text differs too.
  return rows.map((r) =>
    r.kind === 'changed' && r.left !== null && r.right !== null && a[r.left].eq(b[r.right]) ? { ...r, kind: 'same' as const } : r,
  )
}

/** A range to highlight, in document positions of its own side. */
export interface DiffRange {
  from: number
  to: number
}

export interface PassageDiff {
  rows: AlignedRow[]
  /** Removed words on the original page. */
  removed: DiffRange[]
  /** Added words on the revised page. */
  added: DiffRange[]
  /** Whole blocks (start positions) with no counterpart. */
  removedBlocks: number[]
  addedBlocks: number[]
  /** Paired non-text blocks (lists) whose content differs: highlighted whole. */
  changedBlocks: { left: number[]; right: number[] }
}

function blockStarts(doc: PMNode): number[] {
  const out: number[] = []
  doc.forEach((_n, offset) => out.push(offset))
  return out
}

function charRanges(t: BlockText, base: number, from: number, to: number, out: DiffRange[]) {
  // Whitespace-only parts are not highlighted at their ends (a quieter page).
  while (from < to && /\s/.test(t.text[from])) from++
  while (to > from && /\s/.test(t.text[to - 1])) to--
  if (from >= to) return
  const a = base + t.pos[from]
  const b = base + t.pos[to - 1] + t.size[to - 1]
  const last = out[out.length - 1]
  if (last && last.to === a) last.to = b
  else out.push({ from: a, to: b })
}

/** Word-level differences of two passage docs, on aligned rows (`rows` from alignBlocks). */
export function diffPassages(left: PMNode, right: PMNode, rows: AlignedRow[] = alignBlocks(left, right)): PassageDiff {
  const ls = blockStarts(left)
  const rs = blockStarts(right)
  const result: PassageDiff = { rows, removed: [], added: [], removedBlocks: [], addedBlocks: [], changedBlocks: { left: [], right: [] } }
  for (const row of rows) {
    if (row.left !== null && row.right === null) result.removedBlocks.push(ls[row.left])
    else if (row.right !== null && row.left === null) result.addedBlocks.push(rs[row.right])
    if (row.kind !== 'changed' || row.left === null || row.right === null) continue
    const a = left.child(row.left)
    const b = right.child(row.right)
    if (!a.isTextblock || !b.isTextblock) {
      result.changedBlocks.left.push(ls[row.left])
      result.changedBlocks.right.push(rs[row.right])
      continue
    }
    const ta = blockText(a)
    const tb = blockText(b)
    if (ta.text === tb.text) continue
    let ia = 0
    let ib = 0
    for (const part of diffWordsWithSpace(ta.text, tb.text)) {
      const len = part.value.length
      if (part.removed) {
        charRanges(ta, ls[row.left] + 1, ia, ia + len, result.removed)
        ia += len
      } else if (part.added) {
        charRanges(tb, rs[row.right] + 1, ib, ib + len, result.added)
        ib += len
      } else {
        ia += len
        ib += len
      }
    }
  }
  return result
}
