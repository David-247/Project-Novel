import { diffWordsWithSpace } from 'diff'
import type { Node as PMNode } from '@tiptap/pm/model'

/**
 * Comparison of the original passage with a revision (pure; docs/design.md, "Re-write").
 *
 * - Paragraph alignment: identical blocks pair first (prefix, suffix, LCS on block identity); the
 *   blocks between them get a global alignment (Needleman-Wunsch, banded for large gaps) that
 *   maximizes the summed word similarity of the paired blocks. Blocks too different to pair (below
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
 * (footnote reference, hard break) counting as one character. Other blocks (lists, breaks): the text of
 * their paragraphs, one per line, without positions (compared as a whole).
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
    // A list: its paragraphs' text, one per line (the words of two items never run together).
    if (block.isLeaf) text = `\u0000${block.type.name}`
    else {
      const lines: string[] = []
      block.descendants((n) => {
        if (n.isTextblock) lines.push(n.textContent)
        return !n.isTextblock
      })
      text = lines.join('\n')
    }
  }
  t = { text, pos, size }
  textCache.set(block, t)
  return t
}

interface Words {
  counts: Map<string, number>
  total: number
}
const wordsCache = new WeakMap<PMNode, Words>()

function words(block: PMNode): Words {
  let w = wordsCache.get(block)
  if (w) return w
  const counts = new Map<string, number>()
  let total = 0
  for (const raw of blockText(block).text.toLowerCase().split(/[\s￼]+/)) {
    const k = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
    if (!k) continue
    counts.set(k, (counts.get(k) ?? 0) + 1)
    total++
  }
  w = { counts, total }
  wordsCache.set(block, w)
  return w
}

/** Word similarity of two blocks in [0, 1] (Dice coefficient over word multisets). */
export function similarity(a: PMNode, b: PMNode): number {
  // By name: the two pages are separate editors, each with its own (identical) schema.
  if (a.type.name !== b.type.name && (a.isTextblock !== b.isTextblock || !a.isTextblock)) return 0
  if (blockText(a).text === blockText(b).text) return 1
  const wa = words(a)
  const wb = words(b)
  if (wa.total === 0 || wb.total === 0) return wa.total === wb.total ? 0.5 : 0
  const [small, big] = wa.counts.size <= wb.counts.size ? [wa.counts, wb.counts] : [wb.counts, wa.counts]
  let common = 0
  small.forEach((c, w) => (common += Math.min(c, big.get(w) ?? 0)))
  return (2 * common) / (wa.total + wb.total)
}

function children(doc: PMNode): PMNode[] {
  const out: PMNode[] = []
  doc.forEach((n) => out.push(n))
  return out
}

/** Identity of a block's content for the identical-block pass: type and text. */
const keyOf = (n: PMNode) => `${n.type.name}\u0001${blockText(n).text}`

/** Above this many cells a gap is aligned in a band around its diagonal instead of in full. */
const FULL_DP_CELLS = 16_384
/** Extra width of that band on each side of the diagonal (blocks). */
const BAND = 12

/**
 * Align the top-level blocks of two passage docs (see the module comment).
 * 1. Identical blocks first: the common prefix and suffix, then an LCS on block identity (integer
 *    keys) over the middle; on a typical edit everything but a few blocks pairs here.
 * 2. The gaps between identical pairs: a global alignment on word similarity, in full for small gaps,
 *    in a band around the diagonal for large ones. Word counts are cached per (immutable) block.
 */
export function alignBlocks(left: PMNode, right: PMNode): AlignedRow[] {
  const a = children(left)
  const b = children(right)
  const n = a.length
  const m = b.length
  // Integer keys: equal content, equal key.
  const ids = new Map<string, number>()
  const id = (x: PMNode) => {
    const k = keyOf(x)
    let v = ids.get(k)
    if (v === undefined) ids.set(k, (v = ids.size))
    return v
  }
  const ka = a.map(id)
  const kb = b.map(id)
  const rows: AlignedRow[] = []
  const pair = (i: number, j: number) => rows.push({ left: i, right: j, kind: sameBlock(a[i], b[j]) ? 'same' : 'changed' })

  let p = 0
  while (p < n && p < m && ka[p] === kb[p]) p++
  let s = 0
  while (s < n - p && s < m - p && ka[n - 1 - s] === kb[m - 1 - s]) s++
  for (let k = 0; k < p; k++) pair(k, k)
  // Identical pairs in the middle (an LCS on keys), then the gaps between them.
  let i = p
  let j = p
  for (const [x, y] of lcs(ka, kb, p, n - s, p, m - s)) {
    alignGap(a, b, i, x, j, y, rows)
    pair(x, y)
    i = x + 1
    j = y + 1
  }
  alignGap(a, b, i, n - s, j, m - s, rows)
  for (let k = s; k > 0; k--) pair(n - k, m - k)
  return rows
}

/** Index pairs of a longest common subsequence of ka[i0..i1) and kb[j0..j1) (identical blocks). */
function lcs(ka: readonly number[], kb: readonly number[], i0: number, i1: number, j0: number, j1: number): [number, number][] {
  const n = i1 - i0
  const m = j1 - j0
  if (n === 0 || m === 0) return []
  if (n * m > 4_000_000) {
    // Far beyond one chapter: only blocks whose content is unique on both sides, in order.
    const out: [number, number][] = []
    const at = new Map<number, number>()
    const count = new Map<number, number>()
    for (let j = j0; j < j1; j++) count.set(kb[j], (count.get(kb[j]) ?? 0) + 1)
    for (let j = j0; j < j1; j++) if (count.get(kb[j]) === 1) at.set(kb[j], j)
    let last = j0 - 1
    for (let i = i0; i < i1; i++) {
      const j = at.get(ka[i])
      if (j !== undefined && j > last) {
        out.push([i, j])
        last = j
      }
    }
    return out
  }
  // Suffix-form table (Uint16: one chapter is far below 65,535 blocks).
  const W = m + 1
  const t = new Uint16Array((n + 1) * W)
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      t[i * W + j] = ka[i0 + i] === kb[j0 + j] ? t[(i + 1) * W + j + 1] + 1 : Math.max(t[(i + 1) * W + j], t[i * W + j + 1])
  const out: [number, number][] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (ka[i0 + i] === kb[j0 + j]) {
      out.push([i0 + i, j0 + j])
      i++
      j++
    } else if (t[(i + 1) * W + j] >= t[i * W + j + 1]) i++
    else j++
  }
  return out
}

/** Align a[i0..i1) with b[j0..j1) (no identical pairs inside) on word similarity; rows appended in order. */
function alignGap(a: readonly PMNode[], b: readonly PMNode[], i0: number, i1: number, j0: number, j1: number, rows: AlignedRow[]): void {
  const n = i1 - i0
  const m = j1 - j0
  if (n === 0 || m === 0) {
    for (let i = i0; i < i1; i++) rows.push({ left: i, right: null, kind: 'removed' })
    for (let j = j0; j < j1; j++) rows.push({ left: null, right: j, kind: 'added' })
    return
  }
  // A band around the diagonal for big gaps: cell (i, j) is considered when |i·m/n − j| ≤ band.
  const band = n * m <= FULL_DP_CELLS ? Infinity : Math.abs(n - m) + BAND
  const inBand = (i: number, j: number) => band === Infinity || Math.abs(Math.round((i * m) / n) - j) <= band
  const W = m + 1
  const score = new Float64Array((n + 1) * W)
  const sim = new Float64Array(n * m).fill(-1)
  const simAt = (i: number, j: number) => {
    let s = sim[i * m + j]
    if (s < 0) sim[i * m + j] = s = inBand(i, j) ? similarity(a[i0 + i], b[j0 + j]) : 0
    return s
  }
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const s = inBand(i, j) ? simAt(i, j) : 0
      const take = s >= MIN_SIMILARITY ? s + score[(i + 1) * W + j + 1] : -1
      score[i * W + j] = Math.max(take, score[(i + 1) * W + j], score[i * W + j + 1])
    }
  }
  let i = 0
  let j = 0
  const EPS = 1e-9
  while (i < n || j < m) {
    if (i < n && j < m) {
      const s = inBand(i, j) ? simAt(i, j) : 0
      const here = score[i * W + j]
      if (s >= MIN_SIMILARITY && Math.abs(here - (s + score[(i + 1) * W + j + 1])) < EPS) {
        rows.push({ left: i0 + i, right: j0 + j, kind: sameBlock(a[i0 + i], b[j0 + j]) ? 'same' : 'changed' })
        i++
        j++
        continue
      }
      // Removed blocks first, then added ones (a replaced paragraph reads top to bottom).
      if (Math.abs(here - score[(i + 1) * W + j]) < EPS) {
        rows.push({ left: i0 + i++, right: null, kind: 'removed' })
        continue
      }
      rows.push({ left: null, right: j0 + j++, kind: 'added' })
      continue
    }
    if (i < n) rows.push({ left: i0 + i++, right: null, kind: 'removed' })
    else rows.push({ left: null, right: j0 + j++, kind: 'added' })
  }
}

/** Same text, attributes and marks (compared as JSON: the nodes may come from different schemas). */
function sameBlock(a: PMNode, b: PMNode): boolean {
  if (blockText(a).text !== blockText(b).text || a.type.name !== b.type.name) return false
  return JSON.stringify(a.toJSON()) === JSON.stringify(b.toJSON())
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
