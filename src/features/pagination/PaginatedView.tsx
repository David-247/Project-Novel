import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, MouseEvent as ReactMouseEvent, ReactNode } from 'react'
import { Selection, TextSelection } from '@tiptap/pm/state'
import type { Node as PMNode } from '@tiptap/pm/model'
import type { EditorView } from '@tiptap/pm/view'
import { setFindRevealHook, useMountedEditor } from '@/features/editor'
import { useStore } from '@/shared/store'
import { createPaginationPlugin, getEngine, pageAt, paginationKey, selectionForPage } from './engine'
import { resolvePageGeometry } from './geometry'
import { effectiveView, placePages, resolveScale, type Placement } from './placement'
import { doubleClickSlots } from './extension-points'
import { PageFrames } from './PageFrames'
import './pagination.css'

export interface PaginatedViewProps {
  /** The editor (NovelEditor with `paged`). Pagination lays out its single view; it never copies it. */
  children: ReactNode
}

function scrollParent(el: HTMLElement | null): HTMLElement | null {
  for (let n = el?.parentElement ?? null; n; n = n.parentElement) {
    const o = getComputedStyle(n).overflowY
    if (o === 'auto' || o === 'scroll') return n
  }
  return null
}

interface Viewport {
  width: number
  height: number
  /** scrollTop of the scroll container. */
  top: number
  /** Where the canvas starts inside the scroll container's content (px). */
  canvasTop: number
}

function canvasTopIn(scroller: HTMLElement, sizer: HTMLElement | null): number {
  if (!sizer) return 0
  return sizer.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop
}

let goToPageImpl: ((index: number) => boolean) | null = null

/**
 * Edit > Go to Page: caret to the start of page `index` (0-based; a blank page goes to the next
 * one), its spread scrolled to the top, focus in the manuscript. False while no pages are laid out.
 */
export function goToPage(index: number): boolean {
  return goToPageImpl?.(index) ?? false
}

/**
 * The paginated writing surface: pages on a desk, as a two-page spread (or single pages), at the
 * zoom chosen in the status bar. Hosts the editor's one view; see docs/pagination.md.
 */
export function PaginatedView({ children }: PaginatedViewProps) {
  const editor = useMountedEditor()
  const trimSize = useStore((s) => s.book.trimSize)
  const margins = useStore((s) => s.book.margins)
  const requestedView = useStore((s) => s.book.view)
  const pageCount = useStore((s) => s.layout.pageCount)
  const pages = useStore((s) => s.layout.pages)
  const view = useStore((s) => s.layout.effectiveView)
  const zoom = useStore((s) => s.layout.zoom)
  const scale = useStore((s) => s.layout.scale)
  const actions = useStore((s) => s.layoutActions)

  const geometry = useMemo(() => resolvePageGeometry(trimSize, margins), [trimSize, margins])
  const placement = useMemo(() => placePages(pageCount, geometry, view), [pageCount, geometry, view])

  const hostRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLDivElement>(null)
  const sizerRef = useRef<HTMLDivElement>(null)
  const scrollerRef = useRef<HTMLElement | null>(null)
  const [viewport, setViewport] = useState<Viewport>({ width: 0, height: 0, top: 0, canvasTop: 0 })

  // Latest values for the (stable) plugin handlers.
  const live = useRef({ placement, scale })
  useLayoutEffect(() => {
    live.current = { placement, scale }
  }, [placement, scale])

  // ---- Scroll container: its size drives the narrow fallback and fit zooms; its scroll the visible spread.
  useLayoutEffect(() => {
    const scroller = scrollParent(hostRef.current)
    scrollerRef.current = scroller
    if (!scroller) return
    let frame = 0
    const measure = () => {
      frame = 0
      const next = {
        // The desk's own width: something beside it in the scroller (the comments margin panel)
        // narrows the room for the pages. Without a neighbour this equals the scroller's width.
        width: Math.min(scroller.clientWidth, hostRef.current?.clientWidth || scroller.clientWidth),
        height: scroller.clientHeight,
        top: scroller.scrollTop,
        canvasTop: canvasTopIn(scroller, sizerRef.current),
      }
      setViewport((v) =>
        v.width === next.width && v.height === next.height && v.top === next.top && v.canvasTop === next.canvasTop ? v : next,
      )
    }
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(measure)
    }
    measure()
    const ro = new ResizeObserver(onScroll)
    ro.observe(scroller)
    if (hostRef.current) ro.observe(hostRef.current)
    scroller.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      ro.disconnect()
      scroller.removeEventListener('scroll', onScroll)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [])

  // ---- Effective view and scale.
  useEffect(() => {
    actions.setEffectiveView(effectiveView(requestedView, viewport.width, geometry))
  }, [actions, requestedView, viewport.width, geometry])

  useEffect(() => {
    actions.setScale(resolveScale(zoom, viewport, placement, geometry))
  }, [actions, zoom, viewport, placement, geometry])

  // ---- Visible spread (the row at the middle of the viewport) and the rows worth rendering.
  const offsetTop = viewport.canvasTop
  const centerY = (viewport.top + viewport.height / 2 - offsetTop) / scale
  const centerRow = placement.rowAtY(centerY)
  const firstRow = placement.rowAtY((viewport.top - viewport.height - offsetTop) / scale)
  const lastRow = placement.rowAtY((viewport.top + 2 * viewport.height - offsetTop) / scale)
  useEffect(() => {
    const [first, last] = placement.pagesInRow(centerRow)
    actions.setVisibleSpread({ index: centerRow, first, last: Math.min(last, Math.max(0, pageCount - 1)) })
  }, [actions, placement, centerRow, pageCount])

  // ---- Plugin: decorations + engine, page keys, clicks on the desk and margins.
  useEffect(() => {
    if (!editor || editor.isDestroyed) return
    const scrollToRow = (row: number) => {
      const scroller = scrollerRef.current
      if (!scroller) return
      const top = canvasTopIn(scroller, sizerRef.current)
      scroller.scrollTop = Math.max(0, top + (live.current.placement.rowTop(row) - 12) * live.current.scale)
    }
    const plugin = createPaginationPlugin({
      keyDown: (v, e) => {
        const docKey = documentEdgeKey(e)
        if (docKey) return moveToDocumentEdge(v, docKey, e.shiftKey)
        if (e.altKey || e.ctrlKey || e.metaKey) return false
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') return moveLineAcrossPages(v, e.key === 'ArrowDown' ? 1 : -1, e.shiftKey)
        if (e.key !== 'PageDown' && e.key !== 'PageUp') return false
        return moveBySpread(v, e.key === 'PageDown' ? 1 : -1, e.shiftKey, live.current.placement, scrollToRow)
      },
      mouseDown: (v, e) => placeCaretFromDesk(v, e),
    })
    editor.registerPlugin(plugin)
    // The find panel scrolls the current match by its DOM position: finish a reflow in progress first.
    setFindRevealHook(() => getEngine()?.drain())
    goToPageImpl = (index) => {
      if (editor.isDestroyed) return false
      const v = editor.view
      freshSnapshot()
      const pages = useStore.getState().layout.pages
      if (!pages.length) return false
      let i = Math.max(0, Math.min(pages.length - 1, Math.trunc(index)))
      while (i < pages.length - 1 && pages[i].isBlank) i++
      const page = pages[i]
      v.dispatch(v.state.tr.setSelection(selectionForPage(v.state, page)))
      v.focus()
      caretToPageStart(v, page.from)
      scrollToRow(live.current.placement.rowOf(i))
      return true
    }
    return () => {
      goToPageImpl = null
      setFindRevealHook(null)
      if (!editor.isDestroyed) editor.unregisterPlugin(paginationKey)
      actions.resetLayout()
    }
  }, [editor, actions])

  // The selection before the first press of a click sequence: a press in a margin moves the caret to
  // the nearest line, which a double-click on a header / footer should not leave behind.
  const selectionBeforePress = useRef<{ anchor: number; head: number } | null>(null)
  const onMouseDownCapture = (e: ReactMouseEvent) => {
    if (e.detail !== 1 || !editor || editor.isDestroyed) return
    const { anchor, head } = editor.state.selection
    selectionBeforePress.current = { anchor, head }
  }

  // Double-click on a header / footer region (slots are drawn behind the text layer, which covers them).
  const onDoubleClick = (e: ReactMouseEvent) => {
    const canvas = canvasRef.current
    if (!canvas || pages.length === 0) return
    const rect = canvas.getBoundingClientRect()
    const k = placement.canvasWidth ? rect.width / placement.canvasWidth : 1
    const x = (e.clientX - rect.left) / k
    const y = (e.clientY - rect.top) / k
    const [a, b] = placement.pagesInRow(placement.rowAtY(y))
    for (let i = a; i <= Math.min(b, pages.length - 1); i++) {
      const f = placement.frame(i)
      const c = placement.content(i)
      if (x < c.x || x > c.x + geometry.contentWidth) continue
      const region = y >= f.y && y < f.y + geometry.margins.top ? 'header' : y >= f.y + f.height - geometry.margins.bottom && y <= f.y + f.height ? 'footer' : null
      if (!region) continue
      const slot = doubleClickSlots(region)[0]
      if (!slot) return
      e.preventDefault()
      const before = selectionBeforePress.current
      if (before && editor && !editor.isDestroyed) {
        const { doc } = editor.state
        const size = doc.content.size
        const at = (n: number) => Math.min(Math.max(0, n), size)
        try {
          const sel = TextSelection.between(doc.resolve(at(before.anchor)), doc.resolve(at(before.head)))
          if (!sel.eq(editor.state.selection)) editor.view.dispatch(editor.state.tr.setSelection(sel))
        } catch {
          // Document changed since: leave the selection as it is.
        }
      }
      slot.onDoubleClick!(pages[i])
      return
    }
  }

  const canvasStyle = {
    width: placement.canvasWidth,
    height: placement.canvasHeight,
    transform: scale === 1 ? undefined : `scale(${scale})`,
    '--nv-canvas-w': `${placement.canvasWidth}px`,
    '--nv-canvas-h': `${placement.canvasHeight}px`,
    '--nv-text-w': `${geometry.contentWidth}px`,
  } as CSSProperties

  return (
    <div ref={hostRef} className="nv-desk" data-view={view} data-testid="paginated-view">
      <div
        ref={sizerRef}
        className="nv-sizer"
        style={{ width: placement.canvasWidth * scale, height: placement.canvasHeight * scale }}
      >
        <div ref={canvasRef} className="nv-canvas" style={canvasStyle} onMouseDownCapture={onMouseDownCapture} onDoubleClick={onDoubleClick}>
          <PageFrames
            placement={placement}
            pages={pages}
            geometry={geometry}
            firstRow={firstRow}
            lastRow={lastRow}
          />
          <div className="nv-text-layer">{children}</div>
        </div>
      </div>
    </div>
  )
}

/** PageUp / PageDown: caret to the first page of the previous / next spread, scrolled to the top. */
function moveBySpread(view: EditorView, dir: 1 | -1, extend: boolean, placement: Placement, scrollToRow: (row: number) => void): boolean {
  freshSnapshot()
  const pages = useStore.getState().layout.pages
  if (!pages.length) return false
  // A native caret move just before (arrow keys) may not be read yet: take it in first.
  ;(view as unknown as { domObserver?: { flush(): void } }).domObserver?.flush()
  const current = pageAt(pages, view.state.selection.head)
  const currentRow = placement.rowOf(current)
  const row = Math.min(placement.rowCount - 1, Math.max(0, currentRow + dir))
  if (row === currentRow) {
    // No further spread: PageDown goes to the end of the document, PageUp to its start.
    const end = dir > 0 ? Selection.atEnd(view.state.doc) : Selection.atStart(view.state.doc)
    const tr = view.state.tr.setSelection(
      extend ? extendTo(view.state.doc, view.state.selection.anchor, end.head, dir) : end,
    )
    view.dispatch(tr.scrollIntoView())
    return true
  }
  const [first, last] = placement.pagesInRow(row)
  let target = first
  while (target < last && pages[target]?.isBlank) target++
  const page = pages[Math.min(target, pages.length - 1)]
  const sel = selectionForPage(view.state, page)
  const tr = view.state.tr.setSelection(
    extend ? extendTo(view.state.doc, view.state.selection.anchor, sel.head, dir) : sel,
  )
  view.dispatch(tr)
  if (!extend) caretToPageStart(view, page.from)
  scrollToRow(row)
  return true
}

/** The engine's layout, after running a pass that is still pending (the snapshot would be stale). */
function freshSnapshot() {
  const engine = getEngine()
  // Also finishes a progressive reflow: hit tests need every block at its page.
  engine?.drain()
  return engine?.getSnapshot() ?? null
}

/**
 * Document position of the text painted at a client point. The browser's caret hit test works on
 * painted boxes (relative offsets included); ProseMirror's posAtCoords can fall back to layout
 * coordinates, which differ on pages, so ask the browser first.
 */
function posAtPaintedPoint(view: EditorView, x: number, y: number): number | null {
  const doc = view.dom.ownerDocument as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null
    caretRangeFromPoint?: (x: number, y: number) => Range | null
  }
  let node: Node | null = null
  let offset = 0
  const p = doc.caretPositionFromPoint?.(x, y)
  if (p) {
    node = p.offsetNode
    offset = p.offset
  } else {
    const r = doc.caretRangeFromPoint?.(x, y)
    if (r) {
      node = r.startContainer
      offset = r.startOffset
    }
  }
  if (node && view.dom.contains(node) && node !== view.dom) {
    try {
      return view.posAtDOM(node, offset)
    } catch {
      // fall through
    }
  }
  return view.posAtCoords({ left: x, top: y })?.pos ?? null
}

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)

/**
 * Document start / end: Ctrl+Home / Ctrl+End, and Cmd+Up / Cmd+Down on macOS. The browser computes
 * them from the layout column and its own notion of "last line", which on pages lands on an
 * arbitrary page; the slice moves the caret itself.
 */
function documentEdgeKey(e: KeyboardEvent): 1 | -1 | null {
  if (e.altKey) return null
  if (IS_MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey) {
    if (e.key === (IS_MAC ? 'ArrowUp' : 'Home')) return -1
    if (e.key === (IS_MAC ? 'ArrowDown' : 'End')) return 1
  }
  return null
}

/**
 * Selection from `anchor` to `head`, valid even when either end is not in inline content (a page or
 * scene break atom at the edge of the document): TextSelection.between falls back to the nearest
 * valid positions.
 */
export function extendTo(doc: PMNode, anchor: number, head: number, bias: 1 | -1): Selection {
  return TextSelection.between(doc.resolve(anchor), doc.resolve(head), bias)
}

function moveToDocumentEdge(view: EditorView, dir: 1 | -1, extend: boolean): boolean {
  freshSnapshot()
  const edge = dir > 0 ? Selection.atEnd(view.state.doc) : Selection.atStart(view.state.doc)
  const sel = extend ? extendTo(view.state.doc, view.state.selection.anchor, edge.head, dir) : edge
  view.dispatch(view.state.tr.setSelection(sel).scrollIntoView())
  return true
}

/**
 * ArrowDown on a page's last line / ArrowUp on its first line. The browser moves the caret by the
 * layout column, where the next page's lines sit right below with no horizontal offset, so across a
 * page boundary its x position is lost (it snaps to the line start). Move to the painted line
 * instead: same x relative to the text block, on the first (last) line of the next (previous) page.
 * Everywhere else the browser handles the key.
 */
function moveLineAcrossPages(view: EditorView, dir: 1 | -1, extend: boolean): boolean {
  if (!view.state.selection.empty && !extend) return false
  ;(view as unknown as { domObserver?: { flush(): void } }).domObserver?.flush()
  const snap = freshSnapshot()
  if (!snap) return false
  const { pages, ranges, lines, offsets, placement } = snap
  const head = view.state.selection.head
  const p = pageAt(pages, head)
  const r = ranges[p]
  if (!r || r.endLine <= r.startLine) return false
  const root = view.dom as HTMLElement
  let rect = root.getBoundingClientRect()
  const s = root.offsetWidth ? rect.width / root.offsetWidth : 1
  let caret: { left: number; top: number; bottom: number }
  try {
    caret = view.coordsAtPos(head, dir)
  } catch {
    return false
  }
  // The caret's line on its page, by painted position.
  const y = ((caret.top + caret.bottom) / 2 - rect.top) / s
  const edge = dir > 0 ? r.endLine - 1 : r.startLine
  const edgeMid = (lines[edge].top + lines[edge].bottom) / 2 + offsets[p].dy
  const half = (lines[edge].bottom - lines[edge].top) / 2
  if (Math.abs(y - edgeMid) > half) return false
  // Target page: the next / previous one with lines.
  let q = p + dir
  while (q >= 0 && q < pages.length && ranges[q] && ranges[q].endLine <= ranges[q].startLine) q += dir
  if (q < 0 || q >= pages.length || !ranges[q]) return false
  const target = dir > 0 ? ranges[q].startLine : ranges[q].endLine - 1
  const ty = (lines[target].top + lines[target].bottom) / 2 + offsets[q].dy
  const x = (caret.left - rect.left) / s - placement.content(p).x + placement.content(q).x
  // The browser only hit-tests inside the viewport: at fit-spread zoom the next row's verso is often
  // below it. Scroll the target line into view first (the caret goes there anyway).
  const scroller = scrollParent(root)
  if (scroller) {
    const view0 = scroller.getBoundingClientRect()
    const cx = rect.left + x * s
    const cy = rect.top + ty * s
    const margin = 24
    const dy = cy < view0.top + margin ? cy - view0.top - margin : cy > view0.bottom - margin ? cy - view0.bottom + margin + view0.height / 3 : 0
    const dx = cx < view0.left + margin ? cx - view0.left - margin : cx > view0.right - margin ? cx - view0.right + margin : 0
    if (dx || dy) {
      scroller.scrollBy(dx, dy)
      rect = root.getBoundingClientRect()
    }
  }
  const hit = posAtPaintedPoint(view, rect.left + x * s, rect.top + ty * s)
  if (hit === null) return false
  const $pos = view.state.doc.resolve(hit)
  const sel = extend ? extendTo(view.state.doc, view.state.selection.anchor, $pos.pos, dir) : TextSelection.near($pos)
  view.dispatch(view.state.tr.setSelection(sel).scrollIntoView())
  if (!extend && dir > 0) caretToPageStart(view, pages[q].from)
  return true
}

/**
 * A page that starts mid-paragraph starts at the same document position where the previous page's
 * last line ends. ProseMirror draws a caret there at the end of that line (on the previous page);
 * when the caret was put at a page start on purpose, draw it at the top of the page instead. Both
 * DOM positions are equivalent for ProseMirror, so it keeps this one.
 */
function caretToPageStart(view: EditorView, pageFrom: number) {
  const sel = view.state.selection
  if (!sel.empty || sel.head !== pageFrom) return
  try {
    const { node, offset } = view.domAtPos(pageFrom, 1)
    view.dom.ownerDocument.getSelection()?.collapse(node, offset)
  } catch {
    // Position without DOM (should not happen); leave the caret where ProseMirror put it.
  }
}

/**
 * A press on the desk, a margin or the space between paragraphs lands on the editor root (or on the
 * empty part of a block whose last lines were moved to the next page), whose layout box does not
 * match where text is painted. Put the caret on the nearest line of the nearest page instead of
 * letting the browser guess from layout coordinates.
 */
function placeCaretFromDesk(view: EditorView, e: MouseEvent): boolean {
  if (e.button !== 0 || !(e.target instanceof Node) || !view.dom.contains(e.target)) return false
  const snap = freshSnapshot()
  if (!snap || !snap.pages.length) return false
  const root = view.dom as HTMLElement
  const rect = root.getBoundingClientRect()
  const s = root.offsetWidth ? rect.width / root.offsetWidth : 1
  const x = (e.clientX - rect.left) / s
  const y = (e.clientY - rect.top) / s
  const { placement, pages, ranges, lines, offsets, geometry } = snap
  const [a, b] = placement.pagesInRow(placement.rowAtY(y))
  let page = a
  let best = Infinity
  for (let i = a; i <= Math.min(b, pages.length - 1); i++) {
    const f = placement.frame(i)
    const d = x < f.x ? f.x - x : x > f.x + f.width ? x - f.x - f.width : 0
    if (d < best) {
      best = d
      page = i
    }
  }
  // Inside a text block, a press on text (or anything but the bare root) is the browser's to handle.
  const c0 = placement.content(page)
  const inText = x >= c0.x && x <= c0.x + geometry.contentWidth && y >= c0.y && y <= c0.y + geometry.contentHeight
  if (inText && e.target !== view.dom) return false
  while (page < pages.length - 1 && pages[page].isBlank) page++
  const r = ranges[page]
  let pos = pages[page].from
  if (r && r.endLine > r.startLine) {
    const o = offsets[page]
    let li = r.startLine
    let bestD = Infinity
    for (let i = r.startLine; i < r.endLine; i++) {
      const mid = (lines[i].top + lines[i].bottom) / 2 + o.dy
      const d = Math.abs(mid - y)
      if (d < bestD) {
        bestD = d
        li = i
      }
    }
    const c = placement.content(page)
    const cx = Math.min(c.x + geometry.contentWidth - 1, Math.max(c.x + 1, x))
    const cy = (lines[li].top + lines[li].bottom) / 2 + o.dy
    const hit = posAtPaintedPoint(view, rect.left + cx * s, rect.top + cy * s)
    if (hit !== null) pos = hit
  }
  const near = TextSelection.near(view.state.doc.resolve(Math.min(pos, view.state.doc.content.size)))
  const sel = e.shiftKey ? extendTo(view.state.doc, view.state.selection.anchor, near.head, 1) : near
  view.dispatch(view.state.tr.setSelection(sel))
  view.focus()
  if (sel.empty) caretToPageStart(view, pages[page].from)
  e.preventDefault()
  // ProseMirror's own mousedown handling is skipped, but it must still know a click just happened:
  // otherwise a caret moved to the document start soon after focusing (Home, Mod-Home) is taken
  // for Chrome's focus bug and reverted.
  const input = (view as unknown as { input?: { lastClick?: { time: number; x: number; y: number } } }).input
  if (input?.lastClick) input.lastClick = { ...input.lastClick, time: Date.now(), x: e.clientX, y: e.clientY }
  return true
}
