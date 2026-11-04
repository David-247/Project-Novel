import type { Node as PMNode } from '@tiptap/pm/model'
import { Plugin, PluginKey, TextSelection, type EditorState } from '@tiptap/pm/state'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'
import type { BookView } from '@/shared/book'
import { useStore, type PageInfo } from '@/shared/store'
import { breakPages, sideOf, type LineBox, type PageRange, type UnitInfo } from './breaker'
import { hasReservations, isChapterStart, onInvalidate, totalReservation } from './extension-points'
import { resolvePageGeometry, type PageGeometry } from './geometry'
import { blockBreakBefore, lineStart, measureBlock, ownShift, scaleOf, SHIFT_ATTR, type BlockMetrics } from './measure'
import { placePages, type Placement } from './placement'

/**
 * The pagination engine (ADR: docs/pagination.md). One ProseMirror view stays the only editor;
 * its DOM is laid out as a natural single column the width of the text block (the "stream").
 * Each pass:
 *  1. measures line boxes of changed top-level blocks (cache keyed by node identity),
 *  2. breaks the stream into pages (breaker.ts: widows/orphans, keep-with-next, forced breaks,
 *     bottom reservations),
 *  3. moves every page's lines to their page on the canvas with `position: relative` offsets:
 *     node decorations for whole blocks, inline decorations for the lines of a block that continue
 *     on a later page (line-level fragmentation; offsets never change line breaking),
 *  4. publishes the page model to the store's `layout` slice.
 * Passes run in requestAnimationFrame, before paint, after any doc change or settings change.
 */

export const paginationKey = new PluginKey<DecorationSet>('pagination')

interface PageOffset {
  dx: number
  dy: number
}

export interface LayoutSnapshot {
  geometry: PageGeometry
  placement: Placement
  ranges: PageRange[]
  pages: PageInfo[]
  /** Per page: offset from stream to canvas coordinates (blank pages: copy of a neighbour). */
  offsets: PageOffset[]
  /** Stream line boxes, and the page of each line. */
  lines: LineBox[]
  pageOfLine: Int32Array
}

/**
 * ProseMirror view internals used defensively (both optional): `domObserver.flush()` reads pending
 * DOM changes and selection; `input.mouseDown` is set while a pointer press is in progress.
 */
interface ViewInternals {
  domObserver?: { flush(): void; forceFlush?(): void }
  input?: { mouseDown?: unknown }
}

/** Frames a pass may wait for the browser's selection to reach ProseMirror. */
const MAX_DEFERRALS = 5

/**
 * True when the DOM selection is inside the editor but differs from ProseMirror's: a native caret
 * move (Home, End, arrows) whose selectionchange has not been handled yet. Redrawing now would put
 * the old selection back.
 */
function domSelectionPending(view: EditorView): boolean {
  if (!view.hasFocus()) return false
  const sel = view.dom.ownerDocument.getSelection()
  if (!sel?.anchorNode || !sel.focusNode || !view.dom.contains(sel.anchorNode)) return false
  try {
    const anchor = view.posAtDOM(sel.anchorNode, sel.anchorOffset)
    const head = view.posAtDOM(sel.focusNode, sel.focusOffset)
    const s = view.state.selection
    return anchor !== s.anchor || head !== s.head
  } catch {
    return false
  }
}

/** Spec carried by this slice's decorations (also identifies them). */
interface ShiftSpec {
  nvShift: string
  inline: boolean
  /** An inline decoration that runs to the end of its textblock. */
  atEnd: boolean
}

/** Signature of one decoration relative to its block: node decorations by start, inline ones by range. */
function sigPart(spec: ShiftSpec, fromRel: number, toRel: number) {
  return spec.inline ? `i${fromRel}:${spec.atEnd ? 'end' : toRel}:${spec.nvShift}` : `n${fromRel}:${spec.nvShift}`
}

/** Signature of the (mapped) decorations currently drawn on a block. */
function signatureOf(decos: Decoration[], pos: number, end: number) {
  return decos
    .filter((d) => (d.spec as Partial<ShiftSpec>).nvShift !== undefined && d.from >= pos && d.to <= end + 1)
    .sort((a, b) => a.from - b.from || Number((a.spec as ShiftSpec).inline) - Number((b.spec as ShiftSpec).inline))
    .map((d) => {
      const spec = d.spec as ShiftSpec
      return sigPart(spec, d.from - pos, (spec.atEnd ? end : d.to) - pos)
    })
    .join(',')
}

/** Listeners for completed passes (the view uses them to scroll / hit-test). */
type SnapshotListener = (s: LayoutSnapshot) => void

const SHIFT_CLASS = 'nv-shift'

function shiftAttrs(dx: number, dy: number) {
  const x = round(dx)
  const y = round(dy)
  return { class: SHIFT_CLASS, style: `left:${x}px;top:${y}px`, [SHIFT_ATTR]: String(y) }
}

function round(n: number) {
  return Math.round(n * 100) / 100
}

/** Effective view the engine lays out for (the view component decides; see placement.effectiveView). */
let currentEngine: PaginationEngine | null = null

/** The engine of the mounted editor (null when none). Internal to the slice. */
export function getEngine(): PaginationEngine | null {
  return currentEngine
}

export class PaginationEngine {
  private cache = new WeakMap<PMNode, BlockMetrics>()
  private epoch = 0
  private frame = 0
  private flushPending = false
  /** Per block node: signature of its decorations in the last pass (positions relative to the block). */
  private lastSigs = new WeakMap<PMNode, string>()
  /** Per block node: its stream top in the last pass. */
  private prevTops = new Map<PMNode, number>()
  private lastKey = ''
  private snapshot: LayoutSnapshot | null = null
  private listeners = new Set<SnapshotListener>()
  private unsubs: (() => void)[] = []
  private destroyed = false
  private scrollAfterPass = false
  private deferrals = 0

  constructor(private view: EditorView) {
    currentEngine = this // eslint-disable-line @typescript-eslint/no-this-alias
    let prev = useStore.getState()
    this.unsubs.push(
      useStore.subscribe((s) => {
        const p = prev
        prev = s
        if (s.book.trimSize !== p.book.trimSize || s.book.margins !== p.book.margins) this.schedule()
        // Style definitions change block metrics (and data-break-before) without a doc change.
        else if (s.book.styles !== p.book.styles) this.invalidate()
        else if (s.layout.effectiveView !== p.layout.effectiveView) this.schedule()
      }),
      onInvalidate(() => this.invalidate()),
    )
    const fonts = (document as Document & { fonts?: FontFaceSet }).fonts
    if (fonts?.addEventListener) {
      const onFonts = () => this.invalidate()
      fonts.addEventListener('loadingdone', onFonts)
      this.unsubs.push(() => fonts.removeEventListener('loadingdone', onFonts))
    }
    this.schedule()
  }

  /** Drop every measurement and reflow on the next frame. */
  invalidate() {
    this.epoch++
    this.schedule()
  }

  /** Run a pass on the next animation frame (before paint). */
  schedule(scrollIntoView = false) {
    if (scrollIntoView) this.scrollAfterPass = true
    if (this.frame || this.destroyed) return
    this.flushPending = true
    this.frame = requestAnimationFrame(() => {
      this.frame = 0
      this.flushPending = false
      this.run()
    })
  }

  /** Run a pending pass now (tests, and callers that need the model synchronously). */
  flush() {
    if (this.frame) cancelAnimationFrame(this.frame)
    this.frame = 0
    this.flushPending = false
    this.run()
  }

  get pending() {
    return this.flushPending
  }

  getSnapshot(): LayoutSnapshot | null {
    return this.snapshot
  }

  onPass(cb: SnapshotListener): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  destroy() {
    this.destroyed = true
    if (this.frame) cancelAnimationFrame(this.frame)
    this.unsubs.forEach((u) => u())
    if (currentEngine === this) currentEngine = null
  }

  /** Selection moved without a doc change: update `currentPage`. */
  selectionChanged(state: EditorState) {
    const pages = this.snapshot?.pages
    if (!pages || this.flushPending) return
    useStore.getState().layoutActions.setCurrentPage(pageAt(pages, state.selection.head))
  }

  private run() {
    if (this.destroyed) return
    const view = this.view
    const root = view.dom as HTMLElement
    if (!root.isConnected) return
    const internals = view as unknown as ViewInternals
    // Never redraw under an IME composition or a pointer drag; their end updates the view again.
    if (view.composing || internals.input?.mouseDown) {
      this.schedule()
      return
    }
    // Take in DOM changes the browser made but ProseMirror has not read yet (a Home / arrow key's
    // native selection move whose selectionchange is still queued): dispatching on a stale state
    // would write the old selection back into the DOM.
    internals.domObserver?.forceFlush?.()
    internals.domObserver?.flush()
    if (this.deferrals < MAX_DEFERRALS && domSelectionPending(view)) {
      this.deferrals++
      this.schedule()
      return
    }
    this.deferrals = 0
    const { book, layout } = useStore.getState()
    const geometry = resolvePageGeometry(book.trimSize, book.margins)
    const widthPx = `${geometry.contentWidth}px`
    if (root.style.width !== widthPx) root.style.width = widthPx
    if (!root.offsetWidth) return
    const key = `${geometry.contentWidth}|${this.epoch}`
    const t0 = performance.now()
    let measured = 0
    const scale = scaleOf(root)
    const rootTop = root.getBoundingClientRect().top
    const doc = view.state.doc

    // ---- 1. Measure (cached) and assemble the stream.
    const lines: LineBox[] = []
    const units: UnitInfo[] = []
    const unitRef: { block: number; unit: number }[] = []
    const unitNodes: PMNode[] = []
    const blockPos: number[] = []
    const blockDom: HTMLElement[] = []
    const blockMetrics: BlockMetrics[] = []
    const blockNodes: PMNode[] = []
    // Stream tops: unchanged blocks keep their last top plus the shift of the changed blocks above
    // them, so a keystroke reads two element boxes instead of one per block.
    const prevTops = key === this.lastKey ? this.prevTops : new Map<PMNode, number>()
    const nextTops = new Map<PMNode, number>()
    let delta = 0
    let anchor = true
    let b = 0
    // Top-level DOM elements in document order (view.nodeDOM scans from the start: O(n) per call).
    let domChild = root.firstElementChild as (HTMLElement & { pmViewDesc?: { node?: PMNode } }) | null
    const domFor = (node: PMNode, pos: number): HTMLElement | null => {
      while (domChild && domChild.pmViewDesc?.node !== node) {
        // Not this node's element (a widget, or the walk lost sync): fall back to the lookup.
        if (!domChild.pmViewDesc?.node) {
          domChild = domChild.nextElementSibling as typeof domChild
          continue
        }
        return view.nodeDOM(pos) as HTMLElement | null
      }
      const el = domChild
      domChild = (domChild?.nextElementSibling ?? null) as typeof domChild
      return el
    }
    doc.forEach((node, pos) => {
      const dom = domFor(node, pos)
      if (!dom || dom.nodeType !== 1) return
      let m = this.cache.get(node)
      let fresh = false
      if (!m || m.key !== key) {
        m = measureBlock(view, node, pos, dom, scale, key)
        this.cache.set(node, m)
        measured++
        fresh = true
      }
      const known = fresh || nextTops.has(node) ? undefined : prevTops.get(node)
      let top: number
      if (known !== undefined && !anchor) top = known + delta
      else {
        top = (dom.getBoundingClientRect().top - rootTop) / scale - ownShift(dom)
        if (known !== undefined) {
          // Element boxes are snapped to device pixels relative to the scroll position: a block
          // that did not move can read a few hundredths of a px off. Treat that as no move, or
          // every offset below it would flicker between two roundings (and be redrawn).
          delta = Math.abs(top - known) < 0.1 ? 0 : top - known
          top = known + delta
          anchor = false
        } else anchor = true
      }
      // A node instance used twice in the document is never trusted for its top.
      if (nextTops.has(node)) nextTops.set(node, Number.NaN)
      else nextTops.set(node, top)
      const bb = blockBreakBefore(node, dom)
      m.units.forEach((u, k) => {
        units.push({ firstLine: lines.length, lineCount: u.lines.length, breakBefore: k === 0 ? bb : null, keepWithNext: u.keepWithNext })
        unitRef.push({ block: b, unit: k })
        unitNodes.push(u.node)
        const ui = units.length - 1
        for (const l of u.lines) lines.push({ top: top + l.top, bottom: top + l.bottom, unit: ui })
      })
      blockPos.push(pos)
      blockDom.push(dom)
      blockMetrics.push(m)
      blockNodes.push(node)
      b++
    })
    for (const [n, t] of nextTops) if (Number.isNaN(t)) nextTops.delete(n)
    this.prevTops = nextTops

    // Line index -> document position (relative to the doc), lazily.
    const lineToUnitLine = (li: number) => {
      const ui = lines[li].unit
      return { ui, k: li - units[ui].firstLine }
    }
    const posOfLine = (li: number): number => {
      if (li >= lines.length) return doc.content.size
      const { ui, k } = lineToUnitLine(li)
      const { block, unit } = unitRef[ui]
      const m = blockMetrics[block]
      const u = m.units[unit]
      if (k === 0) return blockPos[block] + (unit === 0 ? 0 : u.rel)
      return blockPos[block] + lineStart(view, blockPos[block], blockDom[block], u, k, scale)
    }

    const t1 = performance.now()
    // ---- 2. Break.
    const reserve = hasReservations()
      ? (pageIndex: number, s: number, e: number) =>
          totalReservation({ index: pageIndex, side: sideOf(pageIndex), from: posOfLine(s), to: posOfLine(e) })
      : undefined
    const ranges = breakPages(lines, units, { contentHeight: geometry.contentHeight, reserve })

    const t2 = performance.now()
    // ---- 3. Place and decorate.
    const view0: BookView = layout.effectiveView
    const placement = placePages(ranges.length, geometry, view0)
    const offsets: PageOffset[] = ranges.map((r, i) => {
      const c = placement.content(i)
      const top = r.startLine < lines.length ? lines[r.startLine].top : 0
      return { dx: c.x, dy: c.y - top }
    })
    const pageOfLine = new Int32Array(lines.length)
    ranges.forEach((r, p) => {
      for (let i = r.startLine; i < r.endLine; i++) pageOfLine[i] = p
    })

    const decos: Decoration[] = []
    const current = paginationKey.getState(view.state) ?? DecorationSet.empty
    const geometryChanged = key !== this.lastKey
    let changed = geometryChanged
    // Blocks whose decorations differ from what is drawn: [start in `decos`, end, pos, node size].
    const dirty: [number, number, number, number][] = []
    let lineCursor = 0
    for (let bi = 0; bi < blockNodes.length; bi++) {
      const m = blockMetrics[bi]
      const node = blockNodes[bi]
      const pos = blockPos[bi]
      const nLines = m.units.reduce((s, u) => s + u.lines.length, 0)
      const first = lineCursor
      lineCursor += nLines
      const sigParts: string[] = []
      const start = decos.length
      this.decorateBlock(node, pos, first, m, pageOfLine, offsets, (li) => posOfLine(li), decos, sigParts)
      const sig = sigParts.join(',')
      if (!geometryChanged) {
        // An unchanged node compares with its last signature; an edited one with the decorations
        // ProseMirror mapped through the edit (usually still right: then nothing is redrawn).
        // A node instance used more than once in the document (not in prevTops) has no single last
        // signature: compare with what is drawn at this position.
        const known = this.prevTops.has(node) ? this.lastSigs.get(node) : undefined
        const last = known ?? signatureOf(current.find(pos, pos + node.nodeSize), pos, pos + node.nodeSize - 1)
        if (last !== sig) {
          changed = true
          dirty.push([start, decos.length, pos, node.nodeSize])
        }
      }
      this.lastSigs.set(node, sig)
    }

    const t3 = performance.now()
    // ---- 4. Page model.
    const pages = this.pageModel(ranges, lines, units, unitRef, blockNodes, blockPos, unitNodes, posOfLine, doc.content.size)

    const t4 = performance.now()
    this.lastKey = key
    if (changed) {
      // Few blocks changed (typing moved a split point): patch the drawn set, so ProseMirror redraws
      // only those blocks. Otherwise (a line moved between pages, geometry) rebuild it.
      let next: DecorationSet
      if (!geometryChanged && dirty.length <= 8) {
        next = current
        for (const [a, z, pos, size] of dirty) {
          next = next.remove(next.find(pos, pos + size, (spec) => (spec as Partial<ShiftSpec>).nvShift !== undefined).filter((d) => d.from >= pos && d.to <= pos + size))
          next = next.add(doc, decos.slice(a, z))
        }
      } else next = DecorationSet.create(doc, decos)
      const tr = view.state.tr.setMeta(paginationKey, next).setMeta('addToHistory', false)
      if (this.scrollAfterPass && view.hasFocus()) tr.scrollIntoView()
      view.dispatch(tr)
    }
    this.scrollAfterPass = false
    const t5 = performance.now()

    this.snapshot = { geometry, placement, ranges, pages, offsets, lines, pageOfLine }
    const store = useStore.getState()
    if (!samePages(store.layout.pages, pages)) store.layoutActions.setPages(pages)
    store.layoutActions.setCurrentPage(pageAt(pages, view.state.selection.head))
    this.listeners.forEach((l) => l(this.snapshot!))
    const t6 = performance.now()
    this.timings = {
      measuredBlocks: measured,
      startedAt: t0,
      measureMs: t1 - t0,
      breakMs: t2 - t1,
      decorateMs: t3 - t2,
      modelMs: t4 - t3,
      dispatchMs: t5 - t4,
      publishMs: t6 - t5,
      totalMs: t6 - t0,
      redecorated: changed,
      dirtyBlocks: dirty.length,
      geometryChanged,
    }
  }

  /** Durations of the last pass (diagnostics, perf reports). */
  timings: Record<string, number | boolean> = {}

  /**
   * Decorations for one top-level block whose lines are `[first, first + lines)`.
   * Whole nodes on one page get a node decoration; a textblock that spans pages gets its first
   * page's offset and inline decorations (offset differences) for the lines of each later page.
   * Containers that span pages (lists) are not moved themselves; their children are.
   */
  private decorateBlock(
    node: PMNode,
    pos: number,
    first: number,
    m: BlockMetrics,
    pageOfLine: Int32Array,
    offsets: PageOffset[],
    posOfLine: (li: number) => number,
    out: Decoration[],
    sig: string[],
  ) {
    const push = (from: number, to: number, dx: number, dy: number, inline: boolean, atEnd = false) => {
      const attrs = shiftAttrs(dx, dy)
      const spec: ShiftSpec = { nvShift: attrs.style, inline, atEnd }
      // The last moved lines of a paragraph end at its end: text typed there stays with them.
      out.push(inline ? Decoration.inline(from, to, attrs, { ...spec, inclusiveEnd: atEnd }) : Decoration.node(from, to, attrs, spec))
      sig.push(sigPart(spec, from - pos, to - pos))
    }
    // Line range of each unit (global line indices).
    const unitFirst: number[] = []
    let c = first
    for (const u of m.units) {
      unitFirst.push(c)
      c += u.lines.length
    }
    const unitsIn = (fromRel: number, toRel: number) => {
      const idx: number[] = []
      m.units.forEach((u, i) => {
        if (u.rel >= fromRel && u.rel < toRel) idx.push(i)
      })
      return idx
    }
    const visit = (n: PMNode, nPos: number, rel: number, parent: PageOffset) => {
      const us = rel === 0 ? m.units.map((_, i) => i) : unitsIn(rel, rel + n.nodeSize)
      if (us.length === 0) return
      const lo = unitFirst[us[0]]
      const hi = unitFirst[us[us.length - 1]] + m.units[us[us.length - 1]].lines.length - 1
      const p0 = pageOfLine[lo]
      const o0 = offsets[p0]
      if (pageOfLine[hi] === p0) {
        push(nPos, nPos + n.nodeSize, o0.dx - parent.dx, o0.dy - parent.dy, false)
        return
      }
      if (n.isTextblock || n.isLeaf) {
        push(nPos, nPos + n.nodeSize, o0.dx - parent.dx, o0.dy - parent.dy, false)
        if (!n.isTextblock) return
        const end = nPos + n.nodeSize - 1
        let li = lo + 1
        while (li <= hi) {
          if (pageOfLine[li] === pageOfLine[li - 1]) {
            li++
            continue
          }
          const p = pageOfLine[li]
          let lj = li + 1
          while (lj <= hi && pageOfLine[lj] === p) lj++
          const from = posOfLine(li)
          const to = lj <= hi ? posOfLine(lj) : end
          const o = offsets[p]
          if (to > from) push(from, to, o.dx - o0.dx, o.dy - o0.dy, true, lj > hi)
          li = lj
        }
        return
      }
      // A container spanning pages: leave it in place, move its children.
      n.forEach((child, offset) => visit(child, nPos + 1 + offset, rel + 1 + offset, parent))
    }
    visit(node, pos, 0, { dx: 0, dy: 0 })
  }

  private pageModel(
    ranges: PageRange[],
    lines: LineBox[],
    units: UnitInfo[],
    unitRef: { block: number; unit: number }[],
    blockNodes: PMNode[],
    blockPos: number[],
    unitNodes: PMNode[],
    posOfLine: (li: number) => number,
    docSize: number,
  ): PageInfo[] {
    // Chapter openings (top-level block positions) in order.
    const chapterPos: number[] = []
    blockNodes.forEach((n, i) => {
      if (isChapterStart(n)) chapterPos.push(blockPos[i])
    })
    const starts = ranges.map((r) => (r.startLine >= lines.length ? docSize : posOfLine(r.startLine)))
    if (starts.length) starts[0] = 0
    let ch = -1
    return ranges.map((r, i) => {
      const from = starts[i]
      const to = i + 1 < ranges.length ? starts[i + 1] : docSize
      while (ch + 1 < chapterPos.length && chapterPos[ch + 1] <= from && !(r.blank && chapterPos[ch + 1] === from)) ch++
      let startsBlockType: string | null = null
      if (!r.blank && r.startLine < lines.length) {
        const ui = lines[r.startLine].unit
        if (units[ui].firstLine === r.startLine) {
          const { block, unit } = unitRef[ui]
          startsBlockType = unit === 0 ? blockNodes[block].type.name : unitNodes[ui].type.name
        }
      }
      return { index: i, side: sideOf(i), from, to, isBlank: r.blank, startsBlockType, chapterIndex: ch }
    })
  }
}

export function pageAt(pages: readonly PageInfo[], pos: number): number {
  let lo = 0
  let hi = pages.length - 1
  if (hi < 0) return 0
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (pages[mid].from <= pos) lo = mid
    else hi = mid - 1
  }
  // A blank page never holds the selection.
  while (lo > 0 && pages[lo].isBlank) lo--
  while (lo < pages.length - 1 && pages[lo].isBlank) lo++
  return lo
}

function samePages(a: readonly PageInfo[], b: readonly PageInfo[]) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    const y = b[i]
    if (x.from !== y.from || x.to !== y.to || x.isBlank !== y.isBlank || x.startsBlockType !== y.startsBlockType || x.chapterIndex !== y.chapterIndex) return false
  }
  return true
}

/** Move the selection to the first page of a spread and scroll it to the top. */
export function selectionForPage(state: EditorState, page: PageInfo) {
  const $pos = state.doc.resolve(Math.min(page.from, state.doc.content.size))
  return TextSelection.near($pos, 1)
}

/** The ProseMirror plugin: holds the decorations and drives the engine from view updates. */
export function createPaginationPlugin(handlers: {
  keyDown?: (view: EditorView, e: KeyboardEvent) => boolean
  mouseDown?: (view: EditorView, e: MouseEvent) => boolean
}) {
  return new Plugin<DecorationSet>({
    key: paginationKey,
    state: {
      init: () => DecorationSet.empty,
      apply: (tr, set) => {
        const next = tr.getMeta(paginationKey) as DecorationSet | undefined
        if (next) return next
        return tr.docChanged ? set.map(tr.mapping, tr.doc) : set
      },
    },
    props: {
      decorations: (state) => paginationKey.getState(state),
      handleKeyDown: (view, e) => handlers.keyDown?.(view, e) ?? false,
      handleDOMEvents: {
        mousedown: (view, e) => handlers.mouseDown?.(view, e) ?? false,
      },
    },
    view: (view) => {
      const engine = new PaginationEngine(view)
      return {
        update: (v, prev) => {
          if (v.state.doc !== prev.doc) engine.schedule(true)
          else if (!v.state.selection.eq(prev.selection)) engine.selectionChanged(v.state)
        },
        destroy: () => engine.destroy(),
      }
    },
  })
}
