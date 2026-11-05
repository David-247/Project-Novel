import { diffWordsWithSpace } from 'diff'
import { Fragment, Slice, type Mark, type Node as PMNode } from '@tiptap/pm/model'
import type { Transaction } from '@tiptap/pm/state'
import { REWRITE_BLOCK_ATTR } from '@/shared/rewrite'
import { TRACKING_BLOCK_ATTRS, TRACKING_MARKS } from '@/shared/track-changes'
import { alignBlocks } from './align'

/**
 * Keep This Version: the manuscript passage becomes the version through the smallest edit the
 * comparison view's diff finds (docs/design.md, "Re-write"), not one delete-and-insert:
 * - blocks are paired as on the comparison pages (alignBlocks); an unpaired original block is
 *   deleted, an unpaired version block inserted, a paired list or break that differs replaced whole;
 * - a paired paragraph gets jsdiff's word diff (`diffWordsWithSpace`, as the pages' highlights):
 *   only the words that differ are replaced, so the unchanged text keeps its marks (comments stay
 *   anchored where they were); formatting that differs on unchanged words becomes mark steps, a
 *   different paragraph style one setNodeMarkup;
 * - a footnote whose note text was edited is diffed inside the note (the reference stays).
 * The steps are added to `tr` in descending document order (every position is valid in the start
 * document), so with Track Changes on the recorder turns them into word-level insertions and
 * deletions (and formatting / style changes).
 *
 * `left`: the passage as it is in the manuscript (anchors removed: same sizes); `right`: the version;
 * both in the manuscript's schema. `base`: the passage's position in the manuscript.
 */

/** Marks compared and carried as formatting: not comments (they stay where they are), not tracking marks. */
const IGNORED_MARKS = new Set<string>([...TRACKING_MARKS, 'comment'])
const formatting = (marks: readonly Mark[]) => marks.filter((m) => !IGNORED_MARKS.has(m.type.name))
const marksKey = (marks: readonly Mark[]) => JSON.stringify(formatting(marks).map((m) => m.toJSON()))

/** One position of a node's inline content: a character of text, or an inline atom (footnote, break). */
interface InlineText {
  text: string
  /** Offset (in the parent's content) of unit i. */
  pos: number[]
  size: number[]
  /** The node holding unit i. */
  node: PMNode[]
}

function inlineText(parent: PMNode): InlineText {
  const out: InlineText = { text: '', pos: [], size: [], node: [] }
  parent.forEach((child, offset) => {
    if (child.isText) {
      const s = child.text ?? ''
      for (let i = 0; i < s.length; i++) {
        out.pos.push(offset + i)
        out.size.push(1)
        out.node.push(child)
      }
      out.text += s
    } else {
      // The same unit as the pages' diff (align.ts blockText): never split.
      out.text += child.type.name === 'hardBreak' ? '\n' : '￼'
      out.pos.push(offset)
      out.size.push(child.nodeSize)
      out.node.push(child)
    }
  })
  return out
}

/** Content offset of unit `i` (the end of the content when i is past the last unit). */
const offsetAt = (t: InlineText, i: number, contentSize: number) => (i < t.pos.length ? t.pos[i] : contentSize)

interface Op {
  from: number
  to: number
  run: (tr: Transaction) => void
}

/** Inserted content: no comment marks (a copy never duplicates a thread) and no tracking marks or attributes. */
function clean(fragment: Fragment): Fragment {
  const out: PMNode[] = []
  fragment.forEach((n) => {
    const marks = n.marks.filter((m) => !IGNORED_MARKS.has(m.type.name))
    if (n.isText) return void out.push(n.mark(marks))
    let attrs: Record<string, unknown> = n.attrs
    if (n.attrs[REWRITE_BLOCK_ATTR] != null || TRACKING_BLOCK_ATTRS.some((a) => n.attrs[a] != null)) {
      attrs = { ...n.attrs }
      if (REWRITE_BLOCK_ATTR in attrs) attrs[REWRITE_BLOCK_ATTR] = null
      for (const a of TRACKING_BLOCK_ATTRS) if (a in attrs) attrs[a] = null
    }
    out.push(n.type.create(attrs, n.isLeaf ? null : clean(n.content), marks))
  })
  return Fragment.from(out)
}

/** Attributes that make a paragraph's style and format (not the anchor, not the tracking attributes). */
function styleAttrs(n: PMNode): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(n.attrs)) if (k !== REWRITE_BLOCK_ATTR && !TRACKING_BLOCK_ATTRS.includes(k)) out[k] = v
  return out
}

const sameJSON = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/**
 * Word-level ops turning the inline content of `a` (at document position `start`, its content start)
 * into that of `b`.
 */
function inlineOps(a: PMNode, b: PMNode, start: number, ops: Op[]): void {
  const ta = inlineText(a)
  const tb = inlineText(b)
  const sa = a.content.size
  const sb = b.content.size
  let ia = 0
  let ib = 0
  // A run of removed / added parts: one replacement.
  let hunk: { a0: number; a1: number; b0: number; b1: number } | null = null
  const flush = () => {
    if (!hunk) return
    const from = start + offsetAt(ta, hunk.a0, sa)
    const to = start + offsetAt(ta, hunk.a1, sa)
    const slice = hunk.b1 > hunk.b0 ? b.slice(offsetAt(tb, hunk.b0, sb), offsetAt(tb, hunk.b1, sb)) : Slice.empty
    const content = clean(slice.content)
    ops.push({ from, to, run: (tr) => void tr.replace(from, to, new Slice(content, 0, 0)) })
    hunk = null
  }
  const common = (len: number) => {
    // Same characters: formatting runs that differ, and inline atoms that differ.
    let k = 0
    while (k < len) {
      const na = ta.node[ia + k]
      const nb = tb.node[ib + k]
      if (!na.isText || !nb.isText) {
        const pos = start + ta.pos[ia + k]
        if (na.type.name === 'footnote' && nb.type.name === 'footnote' && sameJSON(na.attrs, nb.attrs)) {
          if (!na.content.eq(nb.content)) inlineOps(na, nb, pos + 1, ops)
        } else if (na.type.name !== nb.type.name || !sameJSON(styleAttrs(na), styleAttrs(nb)) || !na.content.eq(nb.content)) {
          const node = clean(Fragment.from(nb))
          ops.push({ from: pos, to: pos + na.nodeSize, run: (tr) => void tr.replaceWith(pos, pos + na.nodeSize, node) })
        }
        k++
        continue
      }
      const key = marksKey(na.marks) + '\u0001' + marksKey(nb.marks)
      if (marksKey(na.marks) === marksKey(nb.marks)) {
        k++
        continue
      }
      // A run of characters with the same pair of mark sets.
      let e = k + 1
      while (e < len && ta.node[ia + e].isText && tb.node[ib + e].isText && marksKey(ta.node[ia + e].marks) + '\u0001' + marksKey(tb.node[ib + e].marks) === key) e++
      const from = start + ta.pos[ia + k]
      const to = start + ta.pos[ia + e - 1] + 1
      const have = formatting(na.marks)
      const want = formatting(nb.marks)
      ops.push({
        from,
        to,
        run: (tr) => {
          for (const m of have) if (!want.some((w) => w.eq(m))) tr.removeMark(from, to, m)
          for (const m of want) if (!have.some((h) => h.eq(m))) tr.addMark(from, to, m)
        },
      })
      k = e
    }
  }
  for (const part of diffWordsWithSpace(ta.text, tb.text)) {
    const len = part.value.length
    if (part.removed) {
      hunk ??= { a0: ia, a1: ia, b0: ib, b1: ib }
      hunk.a1 = ia += len
    } else if (part.added) {
      hunk ??= { a0: ia, a1: ia, b0: ib, b1: ib }
      hunk.b1 = ib += len
    } else {
      flush()
      common(len)
      ia += len
      ib += len
    }
  }
  flush()
}

/** Add to `tr` the steps turning the passage `left` (at `base` in tr.doc) into `right`. Returns the number of ops. */
export function replacePassage(tr: Transaction, base: number, left: PMNode, right: PMNode): number {
  const rows = alignBlocks(left, right)
  const starts: number[] = []
  left.forEach((_n, offset) => starts.push(offset))
  const ops: Op[] = []
  let after = 0 // end of the last original block seen: where an added block goes
  for (const row of rows) {
    if (row.left !== null) {
      const a = left.child(row.left)
      const from = base + starts[row.left]
      const to = from + a.nodeSize
      after = starts[row.left] + a.nodeSize
      if (row.right === null) {
        ops.push({ from, to, run: (tr) => void tr.delete(from, to) })
        continue
      }
      if (row.kind === 'same') continue
      const b = right.child(row.right)
      if (a.isTextblock && b.isTextblock) {
        inlineOps(a, b, from + 1, ops)
        if (a.type.name !== b.type.name || !sameJSON(styleAttrs(a), styleAttrs(b))) {
          // The version's paragraph style and format; the anchor and the tracking attributes stay as they are.
          const attrs = { ...a.attrs, ...styleAttrs(b) }
          const type = tr.doc.type.schema.nodes[b.type.name]
          // Before the block's inner ops in the sort below (same `from`, wider range last).
          ops.push({ from, to: to + 1, run: (tr) => void tr.setNodeMarkup(from, type, attrs, a.marks) })
        }
      } else {
        const node = clean(Fragment.from(b))
        ops.push({ from, to, run: (tr) => void tr.replaceWith(from, to, node) })
      }
    } else if (row.right !== null) {
      const at = base + after
      const node = clean(Fragment.from(right.child(row.right)))
      ops.push({ from: at, to: at, run: (tr) => void tr.insert(at, node) })
    }
  }
  // Descending: every position is valid in the start document. At one position, the op over a range
  // runs before an insertion there (the insertion goes before that range); several insertions at one
  // position run last first, so they end up in order.
  const order = ops.map((op, i) => ({ op, i }))
  order.sort((x, y) => y.op.from - x.op.from || y.op.to - x.op.to || y.i - x.i)
  for (const { op } of order) op.run(tr)
  return ops.length
}
