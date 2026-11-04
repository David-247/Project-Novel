import type { Node as PMNode } from '@tiptap/pm/model'
import type { EditorView } from '@tiptap/pm/view'
import type { BreakBefore } from './breaker'

/**
 * DOM measurement of the editor's natural (unpaginated) stream. All values are in "stream px":
 * unscaled, and with the page offsets this slice applies (`data-nv-dy`, see decorations.ts)
 * subtracted, so a measurement never depends on the layout it feeds.
 */

/** Attribute carrying the vertical page offset (px) an element was moved by. */
export const SHIFT_ATTR = 'data-nv-dy'

export interface LineMetrics {
  /** Relative to the top of the top-level block's unshifted border box. */
  top: number
  bottom: number
}

/** A fragmentation unit: a textblock (or a top-level block without textblocks). */
export interface UnitMetrics {
  /** Position of the unit's node relative to the start of its top-level block. */
  rel: number
  node: PMNode
  lines: LineMetrics[]
  /** Lazily found start position of line k (relative to the top-level block start). */
  lineStarts: (number | undefined)[]
  keepWithNext: boolean
}

export interface BlockMetrics {
  key: string
  units: UnitMetrics[]
}

/** Vertical offset this slice applied to `el` itself (0 when none). */
export function ownShift(el: Element): number {
  const v = el.getAttribute(SHIFT_ATTR)
  return v ? Number(v) || 0 : 0
}

/** Sum of the offsets of `node`'s ancestors below `block` (exclusive), and of `node` when an element. */
function innerShift(node: Node, block: Element): number {
  let dy = 0
  for (let n: Node | null = node; n && n !== block; n = n.parentNode) if (n.nodeType === 1) dy += ownShift(n as Element)
  return dy
}

/** Scale applied to the editor by a zoom transform on an ancestor. */
export function scaleOf(root: HTMLElement): number {
  const w = root.offsetWidth
  if (!w) return 1
  const s = root.getBoundingClientRect().width / w
  return s > 0 ? s : 1
}

const range = () => document.createRange()

interface Fragment {
  top: number
  bottom: number
}

/** Line fragments of the text and line breaks inside `el`, in block-relative stream px. */
function fragments(el: Element, block: Element, blockTop: number, scale: number, r: Range, out: Fragment[]) {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
    acceptNode: (n) => (n.nodeType === 3 || n.nodeName === 'BR' ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP),
  })
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeType === 3) {
      if (!(n as Text).length) continue
      r.selectNodeContents(n)
    } else r.selectNode(n)
    const shift = innerShift(n.parentNode!, block)
    const rects = r.getClientRects()
    for (let i = 0; i < rects.length; i++) {
      const rc = rects[i]
      if (rc.height <= 0) continue
      out.push({ top: (rc.top - blockTop) / scale - shift, bottom: (rc.bottom - blockTop) / scale - shift })
    }
  }
}

/** Group fragments (in document order) into lines: a fragment whose middle lies within the current line joins it. */
function groupLines(frags: Fragment[]): LineMetrics[] {
  const lines: LineMetrics[] = []
  let cur: LineMetrics | null = null
  for (const f of frags) {
    const mid = (f.top + f.bottom) / 2
    if (cur && mid >= cur.top && mid <= cur.bottom) {
      if (f.top < cur.top) cur.top = f.top
      if (f.bottom > cur.bottom) cur.bottom = f.bottom
      continue
    }
    cur = { top: f.top, bottom: f.bottom }
    lines.push(cur)
  }
  return lines
}

function elementBox(el: Element, block: Element, blockTop: number, scale: number): LineMetrics {
  const rc = el.getBoundingClientRect()
  const shift = el === block ? 0 : innerShift(el, block)
  return { top: (rc.top - blockTop) / scale - shift, bottom: (rc.bottom - blockTop) / scale - shift }
}

/**
 * Measure one top-level block: its textblocks and their line boxes.
 * `blockPos` is the block's document position; `dom` its top-level element.
 */
export function measureBlock(view: EditorView, node: PMNode, blockPos: number, dom: HTMLElement, scale: number, key: string): BlockMetrics {
  const blockTop = dom.getBoundingClientRect().top
  const r = range()
  const units: UnitMetrics[] = []
  const visit = (n: PMNode, rel: number) => {
    const el = rel === 0 ? dom : (view.nodeDOM(blockPos + rel) as Element | null)
    if (!el || el.nodeType !== 1) return
    const frags: Fragment[] = []
    fragments(el, dom, blockTop, scale, r, frags)
    let lines = groupLines(frags)
    if (lines.length === 0) lines = [elementBox(el, dom, blockTop, scale)]
    units.push({ rel, node: n, lines, lineStarts: [], keepWithNext: n.type.name === 'heading' })
  }
  if (node.isTextblock || !hasTextblock(node)) visit(node, 0)
  else
    node.descendants((child, offset) => {
      if (child.isTextblock) {
        visit(child, offset + 1)
        return false
      }
      return true
    })
  if (units.length === 0) units.push({ rel: 0, node, lines: [elementBox(dom, dom, blockTop, scale)], lineStarts: [], keepWithNext: false })
  return { key, units }
}

function hasTextblock(node: PMNode): boolean {
  let found = false
  node.descendants((c) => {
    if (found) return false
    if (c.isTextblock) found = true
    return !found
  })
  return found
}

/**
 * Document position (relative to the top-level block start) of the first character on line `k` of
 * a unit. Binary search over character boxes: the first character whose middle lies below the middle
 * of line k-1. Cached on the unit.
 */
export function lineStart(view: EditorView, blockPos: number, dom: HTMLElement, unit: UnitMetrics, k: number, scale: number): number {
  if (k <= 0) return unit.rel
  const cached = unit.lineStarts[k]
  if (cached !== undefined) return cached
  const el = unit.rel === 0 ? dom : (view.nodeDOM(blockPos + unit.rel) as Element | null)
  const fallback = unit.rel + unit.node.nodeSize - 1
  if (!el) return fallback
  const prev = unit.lines[k - 1]
  const threshold = (prev.top + prev.bottom) / 2 + 0.5
  const blockTop = dom.getBoundingClientRect().top
  const r = range()
  const midOf = (n: Node, a: number, b: number, shift: number): number | null => {
    r.setStart(n, a)
    r.setEnd(n, b)
    const rects = r.getClientRects()
    const rc = rects.length ? rects[rects.length - 1] : null
    if (!rc || rc.height <= 0) return null
    return ((rc.top + rc.bottom) / 2 - blockTop) / scale - shift
  }
  let result = fallback
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
    acceptNode: (n) => (n.nodeType === 3 || n.nodeName === 'BR' ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP),
  })
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const shift = innerShift(n.parentNode!, dom)
    if (n.nodeType !== 3) {
      // A line break: the line after it starts right behind it.
      const parent = n.parentNode!
      const idx = Array.prototype.indexOf.call(parent.childNodes, n)
      r.selectNode(n)
      const rc = r.getBoundingClientRect()
      if (rc.height > 0 && ((rc.top + rc.bottom) / 2 - blockTop) / scale - shift > threshold) {
        result = view.posAtDOM(parent, idx) - blockPos
        break
      }
      continue
    }
    const t = n as Text
    if (!t.length) continue
    const last = midOf(t, t.length - 1, t.length, shift)
    if (last === null || last <= threshold) continue
    let lo = 0
    let hi = t.length - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      const m = midOf(t, mid, mid + 1, shift)
      if (m !== null && m > threshold) hi = mid
      else lo = mid + 1
    }
    result = view.posAtDOM(t, lo) - blockPos
    break
  }
  unit.lineStarts[k] = result
  return result
}

/**
 * Forced break before a top-level block: the node attribute `breakBefore` wins, then the DOM
 * attribute `data-break-before` on the block's element (emitted by style definitions).
 */
export function blockBreakBefore(node: PMNode, dom: Element | null): BreakBefore | null {
  const attr = node.attrs.breakBefore
  if (attr === 'page' || attr === 'recto') return attr
  const d = dom?.getAttribute('data-break-before')
  return d === 'page' || d === 'recto' ? d : null
}
