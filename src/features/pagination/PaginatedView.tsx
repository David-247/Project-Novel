import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { TextSelection } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import { useMountedEditor } from '@/features/editor'
import { useStore } from '@/shared/store'
import { createPaginationPlugin, getEngine, pageAt, paginationKey, selectionForPage } from './engine'
import { resolvePageGeometry } from './geometry'
import { effectiveView, placePages, resolveScale, type Placement } from './placement'
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
        width: scroller.clientWidth,
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
        if ((e.key !== 'PageDown' && e.key !== 'PageUp') || e.altKey || e.ctrlKey || e.metaKey) return false
        return moveBySpread(v, e.key === 'PageDown' ? 1 : -1, e.shiftKey, live.current.placement, scrollToRow)
      },
      mouseDown: (v, e) => placeCaretFromDesk(v, e),
    })
    editor.registerPlugin(plugin)
    return () => {
      if (!editor.isDestroyed) editor.unregisterPlugin(paginationKey)
      actions.resetLayout()
    }
  }, [editor, actions])

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
        <div className="nv-canvas" style={canvasStyle}>
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
  const pages = useStore.getState().layout.pages
  if (!pages.length) return false
  const current = pageAt(pages, view.state.selection.head)
  const row = Math.min(placement.rowCount - 1, Math.max(0, placement.rowOf(current) + dir))
  const [first, last] = placement.pagesInRow(row)
  let target = first
  while (target < last && pages[target]?.isBlank) target++
  const page = pages[Math.min(target, pages.length - 1)]
  const sel = selectionForPage(view.state, page)
  const tr = view.state.tr.setSelection(
    extend ? TextSelection.create(view.state.doc, view.state.selection.anchor, sel.head) : sel,
  )
  view.dispatch(tr)
  if (!extend) caretToPageStart(view, page.from)
  scrollToRow(row)
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
  const snap = getEngine()?.getSnapshot()
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
    const hit = view.posAtCoords({ left: rect.left + cx * s, top: rect.top + cy * s })
    if (hit) pos = hit.pos
  }
  const near = TextSelection.near(view.state.doc.resolve(Math.min(pos, view.state.doc.content.size)))
  const sel = e.shiftKey ? TextSelection.create(view.state.doc, view.state.selection.anchor, near.head) : near
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
