import { Extension } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import { Plugin, PluginKey, type Transaction } from '@tiptap/pm/state'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'
import type { AlignedRow, PassageDiff } from './align'

/**
 * Decorations of the two comparison pages:
 * - alignment pads: `padding-top` on a block so that paired paragraphs start level on both pages
 *   (padding, unlike a spacer element, never changes how the margins between blocks collapse);
 * - differences: inline highlights of removed / added words, whole-block marks for unpaired blocks.
 * Both are replaced through transaction meta (no document change, never in the undo history) and
 * mapped through edits in between.
 */
export const padsKey = new PluginKey<DecorationSet>('nvRewritePads')
export const diffKey = new PluginKey<DecorationSet>('nvRewriteDiff')

function setPlugin(key: PluginKey<DecorationSet>) {
  return new Plugin<DecorationSet>({
    key,
    state: {
      init: () => DecorationSet.empty,
      apply(tr, set) {
        const next = tr.getMeta(key) as DecorationSet | undefined
        if (next) return next
        return tr.docChanged ? set.map(tr.mapping, tr.doc) : set
      },
    },
    props: { decorations: (state) => key.getState(state) },
  })
}

/** Both plugins, as a Tiptap extension for the comparison pages' editors. */
export const CompareDecorations = Extension.create({
  name: 'rewriteCompare',
  addProseMirrorPlugins: () => [setPlugin(padsKey), setPlugin(diffKey)],
})

function meta(view: EditorView, key: PluginKey<DecorationSet>, set: DecorationSet): Transaction {
  return view.state.tr.setMeta(key, set).setMeta('addToHistory', false)
}

/** Block start positions of a passage doc. */
export function blockStarts(doc: PMNode): number[] {
  const out: number[] = []
  doc.forEach((_n, offset) => out.push(offset))
  return out
}

/** Show `diff` on one side (null: no highlights). */
export function applyDiff(view: EditorView, side: 'left' | 'right', diff: PassageDiff | null): void {
  const doc = view.state.doc
  if (!diff) {
    if (diffKey.getState(view.state) !== DecorationSet.empty) view.dispatch(meta(view, diffKey, DecorationSet.empty))
    return
  }
  const decos: Decoration[] = []
  const ranges = side === 'left' ? diff.removed : diff.added
  const cls = side === 'left' ? 'nv-rw-del' : 'nv-rw-ins'
  for (const r of ranges) if (r.to > r.from && r.to <= doc.content.size) decos.push(Decoration.inline(r.from, r.to, { class: cls }))
  const blocks = side === 'left' ? diff.removedBlocks : diff.addedBlocks
  const blockCls = side === 'left' ? 'nv-rw-del-block' : 'nv-rw-ins-block'
  const changed = side === 'left' ? diff.changedBlocks.left : diff.changedBlocks.right
  for (const [list, c] of [
    [blocks, blockCls],
    [changed, 'nv-rw-chg-block'],
  ] as const) {
    for (const pos of list) {
      const node = doc.nodeAt(pos)
      if (node) decos.push(Decoration.node(pos, pos + node.nodeSize, { class: c }))
    }
  }
  view.dispatch(meta(view, diffKey, DecorationSet.create(doc, decos)))
}

/** Current alignment pads of a view, by block index (0 when none). */
export function currentPads(view: EditorView): number[] {
  const set = padsKey.getState(view.state) ?? DecorationSet.empty
  const starts = blockStarts(view.state.doc)
  const pads = new Array<number>(starts.length).fill(0)
  const index = new Map(starts.map((s, i) => [s, i]))
  for (const d of set.find()) {
    const i = index.get(d.from)
    const p = (d.spec as { pad?: number }).pad
    if (i !== undefined && typeof p === 'number') pads[i] = p
  }
  return pads
}

/** Set the alignment pads of a view (block index -> px). No-op when nothing changed. */
export function applyPads(view: EditorView, pads: readonly number[]): void {
  const now = currentPads(view)
  if (now.length === pads.length && now.every((p, i) => p === (pads[i] ?? 0))) return
  const doc = view.state.doc
  const decos: Decoration[] = []
  let i = 0
  doc.forEach((node, offset) => {
    const p = pads[i++] ?? 0
    if (p > 0) decos.push(Decoration.node(offset, offset + node.nodeSize, { style: `padding-top: ${p}px; --nv-rw-pad: ${p}px` }, { pad: p }))
  })
  view.dispatch(meta(view, padsKey, DecorationSet.create(doc, decos)))
}

export interface Stitch {
  /** Row's text start (px from the top of the page text). */
  top: number
  kind: AlignedRow['kind']
}

/**
 * New pads so that every paired row starts level on both pages. `natL` / `natR`: each block's top
 * without any pad (px, same origin on both sides). Works top-down: a pair whose sides differ gets
 * the difference as a pad on the higher side, which moves every later block of that side down.
 */
export function computePads(rows: readonly AlignedRow[], natL: readonly number[], natR: readonly number[]): { left: number[]; right: number[]; stitches: Stitch[] } {
  const left = new Array<number>(natL.length).fill(0)
  const right = new Array<number>(natR.length).fill(0)
  let sumL = 0
  let sumR = 0
  const stitches: Stitch[] = []
  for (const row of rows) {
    // Rows from before a paragraph was added or removed (re-pairing is debounced): skip what is gone.
    if ((row.left !== null && row.left >= natL.length) || (row.right !== null && row.right >= natR.length)) continue
    if (row.left !== null && row.right !== null) {
      const l = natL[row.left] + sumL
      const r = natR[row.right] + sumR
      const d = Math.round(r - l)
      if (d > 0) {
        left[row.left] = d
        sumL += d
      } else if (d < 0) {
        right[row.right] = -d
        sumR += -d
      }
      stitches.push({ top: Math.max(l, r), kind: row.kind })
    } else if (row.left !== null) {
      stitches.push({ top: natL[row.left] + sumL, kind: row.kind })
    } else if (row.right !== null) {
      stitches.push({ top: natR[row.right] + sumR, kind: row.kind })
    }
  }
  return { left, right, stitches }
}

/**
 * Measure a view's blocks: their tops without pads, relative to `origin` (px). Reads layout once
 * per block (getBoundingClientRect).
 */
export function naturalTops(view: EditorView, origin: number): number[] {
  const pads = currentPads(view)
  const tops: number[] = []
  let before = 0
  let i = 0
  view.state.doc.forEach((_node, offset) => {
    const dom = view.nodeDOM(offset) as HTMLElement | null
    const top = dom?.getBoundingClientRect ? dom.getBoundingClientRect().top - origin : 0
    tops.push(top - before)
    before += pads[i++] ?? 0
  })
  return tops
}
