import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, MouseEvent as ReactMouseEvent, ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { Selection, TextSelection } from '@tiptap/pm/state'
import type { Node as PMNode } from '@tiptap/pm/model'
import type { EditorView } from '@tiptap/pm/view'
import { setFindRevealHook, useMountedEditor } from '@/features/editor'
import { prefersReducedMotion } from '@/features/settings'
import { useStore, type PageInfo } from '@/shared/store'
import { createPaginationPlugin, getEngine, onAnyPass, pageAt, paginationKey, selectionForPage, setViewWindowProvider } from './engine'
import { resolvePageGeometry } from './geometry'
import { bookRowHeight, DESK_PAD, effectiveView, placePages, resolveScale, TURN_LANE, type Placement } from './placement'
import { doubleClickSlots } from './extension-points'
import { PageFrames } from './PageFrames'
import { TurnControls } from './TurnControls'
import { goToEdgeSpread, setNavigator, turnSpread } from './navigation'
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

/** Wheel / trackpad events closer together than this belong to one gesture (one page turn). */
export const WHEEL_GESTURE_GAP_MS = 220

/** Duration of the page-turn transition (skipped when motion is reduced). */
const TURN_MS = 160

/**
 * The paginated writing surface: pages on a desk, as a two-page spread (or single pages), at the
 * zoom chosen in the status bar. Hosts the editor's one view; see docs/pagination.md.
 *
 * Two navigation modes (app preference `pageNavigation`): **Book** (default) shows exactly one spread,
 * clipped from the same canvas (the canvas is translated so the spread's row sits in a one-row
 * window), and the writer turns pages; **continuous scroll** stacks every spread vertically (Phase 2).
 * Either way the engine, the page model and the single ProseMirror view are the same.
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
  const spreadFirst = useStore((s) => s.layout.visibleSpread.first)
  const book = useStore((s) => s.preferences.pageNavigation) !== 'scroll'
  const actions = useStore((s) => s.layoutActions)

  const geometry = useMemo(() => resolvePageGeometry(trimSize, margins), [trimSize, margins])
  const placement = useMemo(() => placePages(pageCount, geometry, view), [pageCount, geometry, view])

  const hostRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLDivElement>(null)
  const sizerRef = useRef<HTMLDivElement>(null)
  const scrollerRef = useRef<HTMLElement | null>(null)
  const [viewport, setViewport] = useState<Viewport>({ width: 0, height: 0, top: 0, canvasTop: 0 })

  // Book mode: the row shown, from the first page of the visible spread (so it survives a change of
  // view, single <-> spread, and of page count).
  const bookRow = placement.rowOf(Math.max(0, Math.min(spreadFirst, Math.max(0, pageCount - 1))))

  // Latest values for the (stable) plugin handlers.
  const live = useRef({ placement, scale, book, bookRow })
  useLayoutEffect(() => {
    live.current = { placement, scale, book, bookRow }
  }, [placement, scale, book, bookRow])

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

  // ---- Effective view and scale. Book mode keeps a lane on each side for the turn controls.
  const roomWidth = book ? Math.max(0, viewport.width - 2 * TURN_LANE) : viewport.width
  useEffect(() => {
    actions.setEffectiveView(effectiveView(requestedView, roomWidth, geometry))
  }, [actions, requestedView, roomWidth, geometry])

  useEffect(() => {
    actions.setScale(resolveScale(zoom, { width: roomWidth, height: viewport.height }, placement, geometry))
  }, [actions, zoom, roomWidth, viewport.height, placement, geometry])

  // ---- Visible spread. Scroll: the row at the middle of the viewport. Book: set by navigation.
  const offsetTop = viewport.canvasTop
  const centerY = (viewport.top + viewport.height / 2 - offsetTop) / scale
  const centerRow = placement.rowAtY(centerY)
  const firstRow = book ? bookRow : placement.rowAtY((viewport.top - viewport.height - offsetTop) / scale)
  const lastRow = book ? bookRow : placement.rowAtY((viewport.top + 2 * viewport.height - offsetTop) / scale)
  useEffect(() => {
    if (book) return
    const [first, last] = placement.pagesInRow(centerRow)
    actions.setVisibleSpread({ index: centerRow, first, last: Math.min(last, Math.max(0, pageCount - 1)) })
  }, [actions, placement, centerRow, pageCount, book])

  // Book: keep the store's spread equal to the row shown (a view or page count change can move it).
  useLayoutEffect(() => {
    if (!book) return
    const [first, last] = placement.pagesInRow(bookRow)
    actions.setVisibleSpread({ index: bookRow, first, last: Math.min(last, Math.max(0, pageCount - 1)) })
  }, [actions, placement, bookRow, pageCount, book])

  // The engine draws the pages shown first: in Book mode the spread on the canvas, not the scroll viewport.
  useEffect(() => {
    if (!book) return
    setViewWindowProvider(() => {
      const s = useStore.getState().layout.visibleSpread
      return [s.first, s.last]
    })
    return () => setViewWindowProvider(null)
  }, [book])

  // ---- Book: a turned-to spread is fully drawn before it is painted, then (optionally) eased in.
  const shownRow = useRef<number | null>(null)
  const caretScrollPending = useRef(false)
  useLayoutEffect(() => {
    const prev = shownRow.current
    shownRow.current = book ? bookRow : null
    if (!book) return
    // Blocks still waiting for their offsets after a reflow are hidden (.nv-stale): draw the ones on
    // this spread now, in this task, so the spread is never shown half drawn.
    const engine = getEngine()
    if (prev !== bookRow && engine?.catchingUp) engine.flush()
    if (prev !== null && prev !== bookRow) {
      const sizer = sizerRef.current
      if (sizer && typeof sizer.animate === 'function' && !prefersReducedMotion()) {
        const dx = bookRow > prev ? 14 : -14
        sizer.animate([{ opacity: 0.55, transform: `translateX(${dx}px)` }, { opacity: 1, transform: 'none' }], {
          duration: TURN_MS,
          easing: 'cubic-bezier(0.2, 0.7, 0.3, 1)',
        })
      }
    }
    if (caretScrollPending.current) {
      caretScrollPending.current = false
      if (editor && !editor.isDestroyed) keepCaretInScroller(editor.view, scrollerRef.current)
    }
  }, [book, bookRow, editor])

  // Switching modes: continuous scroll starts at the spread Book mode showed, Book mode at the top.
  const lastMode = useRef(book)
  useLayoutEffect(() => {
    if (lastMode.current === book) return
    lastMode.current = book
    const scroller = scrollerRef.current
    if (!scroller) return
    if (book) scroller.scrollTop = 0
    else {
      const row = live.current.placement.rowOf(useStore.getState().layout.visibleSpread.first)
      scroller.scrollTop = Math.max(0, canvasTopIn(scroller, sizerRef.current) + (live.current.placement.rowTop(row) - 12) * live.current.scale)
    }
  }, [book])

  // ---- Plugin: decorations + engine, page keys, clicks on the desk and margins, caret follow.
  useEffect(() => {
    if (!editor || editor.isDestroyed) return
    const rowCount = () => live.current.placement.rowCount
    /** Book mode: show `row` (clamped). `sync` renders it before returning (hit tests right after). */
    const showRow = (row: number, sync = false) => {
      const p = live.current.placement
      const r = Math.max(0, Math.min(p.rowCount - 1, row))
      const [first, last] = p.pagesInRow(r)
      const count = Math.max(1, useStore.getState().layout.pageCount)
      const apply = () => actions.setVisibleSpread({ index: r, first, last: Math.min(last, count - 1) })
      if (r !== live.current.bookRow) {
        const scroller = scrollerRef.current
        if (scroller) scroller.scrollTop = 0
      }
      if (sync) flushSync(apply)
      else apply()
    }
    const scrollToRow = (row: number) => {
      // Rendered before returning: the caret-follow that a selection change queues compares with it.
      if (live.current.book) return showRow(row, true)
      const scroller = scrollerRef.current
      if (!scroller) return
      const top = canvasTopIn(scroller, sizerRef.current)
      scroller.scrollTop = Math.max(0, top + (live.current.placement.rowTop(row) - 12) * live.current.scale)
    }
    /** Book: the page `page` is on the canvas (turning to it now if not), for hit tests on it. */
    const ensurePageShown = (page: number) => {
      if (!live.current.book) return
      const row = live.current.placement.rowOf(page)
      if (row !== live.current.bookRow) showRow(row, true)
    }

    // Caret follow (Book): when the selection head leaves the spread, turn to the spread holding it.
    let followQueued = false
    let followAfterPass = false
    let followScroll = false
    const follow = () => {
      followQueued = false
      if (!live.current.book || editor.isDestroyed) return
      const engine = getEngine()
      if (engine?.pending && !engine.catchingUp) {
        // A document change not laid out yet: its page is known after the pass.
        followAfterPass = true
        return
      }
      const snap = engine?.getSnapshot()
      if (!snap || !snap.pages.length) return
      const row = caretRow(editor.view, snap.pages, live.current.placement)
      const scroll = followScroll
      followScroll = false
      if (row !== live.current.bookRow) {
        caretScrollPending.current = scroll
        showRow(row)
      } else if (scroll) keepCaretInScroller(editor.view, scrollerRef.current)
    }
    const queueFollow = (scroll: boolean) => {
      if (!live.current.book) return
      if (scroll) followScroll = true
      if (followQueued) return
      followQueued = true
      queueMicrotask(follow)
    }

    const plugin = createPaginationPlugin({
      keyDown: (v, e) => {
        const docKey = documentEdgeKey(e)
        if (docKey) return moveToDocumentEdge(v, docKey, e.shiftKey)
        if (e.altKey || e.ctrlKey || e.metaKey) return false
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp')
          return moveLineAcrossPages(v, e.key === 'ArrowDown' ? 1 : -1, e.shiftKey, ensurePageShown)
        if (e.key !== 'PageDown' && e.key !== 'PageUp') return false
        return moveBySpread(v, e.key === 'PageDown' ? 1 : -1, e.shiftKey, live.current.placement, scrollToRow)
      },
      mouseDown: (v, e) => placeCaretFromDesk(v, e),
      // Book: never scroll the clipped stream; turn to the caret's spread (and keep it in the window
      // when the zoom makes the spread taller than the window).
      scrollToSelection: () => {
        if (!live.current.book) return false
        queueFollow(true)
        return true
      },
      selectionMoved: () => queueFollow(false),
    })
    editor.registerPlugin(plugin)
    const offPass = onAnyPass(() => {
      if (!followAfterPass) return
      followAfterPass = false
      queueFollow(false)
    })
    // The find panel scrolls the current match by its DOM position: finish a reflow in progress first.
    // In Book mode turn to the match's spread instead (the stream outside the spread is clipped).
    setFindRevealHook((el) => {
      getEngine()?.drain()
      if (!live.current.book || !el) return false
      const row = rowOfElement(editor.view, el, live.current.placement)
      if (row !== null && row !== live.current.bookRow) showRow(row, true)
      keepRectInScroller(el.getBoundingClientRect(), scrollerRef.current)
      return true
    })
    setNavigator({
      goToPage: (index) => {
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
      },
      turn: (dir) => {
        if (!useStore.getState().layout.pageCount) return false
        const current = live.current.book ? live.current.bookRow : useStore.getState().layout.visibleSpread.index
        const row = current + dir
        if (row < 0 || row >= rowCount()) return false
        scrollToRow(row)
        return true
      },
      showPage: (index) => {
        const count = useStore.getState().layout.pageCount
        if (!count) return false
        scrollToRow(live.current.placement.rowOf(Math.max(0, Math.min(count - 1, Math.trunc(index)))))
        return true
      },
      edge: (dir) => {
        if (!useStore.getState().layout.pageCount) return false
        scrollToRow(dir > 0 ? rowCount() - 1 : 0)
        return true
      },
      reveal: (pos) => {
        if (editor.isDestroyed) return false
        const v = editor.view
        getEngine()?.drain()
        const p = Math.max(0, Math.min(pos, v.state.doc.content.size))
        let c: { top: number; bottom: number; left: number; right: number }
        try {
          c = v.coordsAtPos(p, 1)
        } catch {
          return false
        }
        const scroller = scrollerRef.current
        if (live.current.book) {
          const row = rowOfClientY(v, (c.top + c.bottom) / 2, live.current.placement)
          if (row !== null && row !== live.current.bookRow) {
            showRow(row, true)
            try {
              c = v.coordsAtPos(p, 1)
            } catch {
              return true
            }
          }
          keepRectInScroller(c, scroller)
          return true
        }
        // Continuous scroll: to the middle of the window, so its spread is the visible one.
        if (!scroller) return false
        const r = scroller.getBoundingClientRect()
        scroller.scrollTop += (c.top + c.bottom) / 2 - (r.top + r.height / 2)
        return true
      },
    })
    return () => {
      setNavigator(null)
      offPass()
      setFindRevealHook(null)
      if (!editor.isDestroyed) editor.unregisterPlugin(paginationKey)
      actions.resetLayout()
    }
  }, [editor, actions])

  // ---- Book: wheel / trackpad turns one spread per gesture; keys outside the manuscript turn too.
  useEffect(() => {
    const host = hostRef.current
    if (!book || !host) return
    // One gesture: wheel events less than WHEEL_GESTURE_GAP_MS apart (a trackpad swipe and its
    // momentum, a fast spin of the wheel). It turns at most one spread.
    let lastAt = -Infinity
    let turned = false
    let scrolls = false
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.defaultPrevented) return // pinch zoom / handled
      const horizontal = Math.abs(e.deltaX) > Math.abs(e.deltaY)
      const d = horizontal ? e.deltaX : e.deltaY
      if (Math.abs(d) < 0.5) return
      const dir: 1 | -1 = d > 0 ? 1 : -1
      const start = e.timeStamp - lastAt > WHEEL_GESTURE_GAP_MS
      lastAt = e.timeStamp
      if (start) {
        turned = false
        // A spread taller than the window (zoomed in) scrolls within itself; a gesture that starts
        // at its edge turns the page.
        const scroller = scrollerRef.current
        const room = !scroller || horizontal ? 0 : dir > 0 ? scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop : scroller.scrollTop
        scrolls = room > 1
      }
      if (scrolls) return
      e.preventDefault()
      if (turned) return
      turned = true
      turnSpread(dir)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.isComposing) return
      const t = e.target
      if (t instanceof Element && t !== document.body && !host.contains(t)) return
      if (t instanceof Element && editor && !editor.isDestroyed && editor.view.dom.contains(t)) return
      const docKey = documentEdgeKey(e)
      if (docKey) {
        e.preventDefault()
        goToEdgeSpread(docKey)
        return
      }
      if (e.ctrlKey || e.metaKey || e.shiftKey) return
      if (e.key === 'PageDown' || e.key === 'PageUp') {
        e.preventDefault()
        turnSpread(e.key === 'PageDown' ? 1 : -1)
      }
    }
    host.addEventListener('wheel', onWheel, { passive: false })
    window.addEventListener('keydown', onKey)
    return () => {
      host.removeEventListener('wheel', onWheel)
      window.removeEventListener('keydown', onKey)
    }
  }, [book, editor])

  // ---- Book: a press on the blank desk beside the spread turns the page (left: back, right: on).
  const blankSide = (e: ReactMouseEvent): 1 | -1 | 0 => {
    if (!book || e.button !== 0 || e.target !== e.currentTarget) return 0
    const r = sizerRef.current?.getBoundingClientRect()
    if (!r) return 0
    return e.clientX < r.left ? -1 : e.clientX > r.right ? 1 : 0
  }
  const onDeskMouseDown = (e: ReactMouseEvent) => {
    // Keep the focus (and the caret) in the manuscript: the next keystroke turns back to it.
    if (blankSide(e)) e.preventDefault()
  }
  const onDeskClick = (e: ReactMouseEvent) => {
    const side = blankSide(e)
    if (side) turnSpread(side)
  }

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
      // Book: a caret left on another spread stays where the press put it (on this one); restoring
      // it would turn the page away from the header being edited.
      const offSpread = book && before && pageRow(before.head, placement) !== bookRow
      if (before && !offSpread && editor && !editor.isDestroyed) {
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

  const rowH = bookRowHeight(geometry)
  // Book: the canvas moves up so the row shown sits in the one-row window (the sizer clips the rest).
  const shift = book ? (placement.rowTop(bookRow) - DESK_PAD) * scale : 0
  const transform = [shift ? `translateY(${-shift}px)` : '', scale === 1 ? '' : `scale(${scale})`].filter(Boolean).join(' ')
  const canvasStyle = {
    width: placement.canvasWidth,
    height: placement.canvasHeight,
    transform: transform || undefined,
    '--nv-canvas-w': `${placement.canvasWidth}px`,
    '--nv-canvas-h': `${placement.canvasHeight}px`,
    '--nv-text-w': `${geometry.contentWidth}px`,
  } as CSSProperties

  return (
    <div
      ref={hostRef}
      className="nv-desk"
      data-view={view}
      data-navigation={book ? 'book' : 'scroll'}
      data-testid="paginated-view"
      onMouseDown={onDeskMouseDown}
      onClick={onDeskClick}
    >
      <div
        ref={sizerRef}
        className="nv-sizer"
        data-row={book ? bookRow : undefined}
        style={{ width: placement.canvasWidth * scale, height: (book ? rowH : placement.canvasHeight) * scale }}
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
      {book ? <TurnControls row={bookRow} rowCount={placement.rowCount} /> : null}
    </div>
  )
}

/** Row of the page holding `pos` (from the published model). */
function pageRow(pos: number, placement: Placement): number {
  return placement.rowOf(pageAt(useStore.getState().layout.pages, pos))
}

/** Canvas row painted at client y (the editor root is the canvas-sized text layer). */
function rowOfClientY(view: EditorView, clientY: number, placement: Placement): number | null {
  const root = view.dom as HTMLElement
  const rect = root.getBoundingClientRect()
  const s = root.offsetHeight ? rect.height / root.offsetHeight : 1
  if (!Number.isFinite(clientY) || !s) return null
  return placement.rowAtY((clientY - rect.top) / s)
}

function rowOfElement(view: EditorView, el: Element, placement: Placement): number | null {
  const r = el.getBoundingClientRect()
  if (!r.width && !r.height) return null
  return rowOfClientY(view, (r.top + r.bottom) / 2, placement)
}

/**
 * Row of the spread holding the selection head. A head exactly at the start of a page that begins
 * mid-paragraph is also the end of the previous page's last line: there the painted caret decides
 * (ProseMirror draws it at the line end, PageDown and Go to Page at the top of the next page).
 */
function caretRow(view: EditorView, pages: readonly PageInfo[], placement: Placement): number {
  const head = view.state.selection.head
  const page = pageAt(pages, head)
  const p = pages[page]
  if (page > 0 && p && p.from === head && p.startsBlockType === null) {
    const sel = view.dom.ownerDocument.getSelection()
    if (sel?.focusNode && view.dom.contains(sel.focusNode)) {
      try {
        const r = view.dom.ownerDocument.createRange()
        r.setStart(sel.focusNode, sel.focusOffset)
        r.collapse(true)
        const rc = Array.from(r.getClientRects()).find((x) => x.height > 0)
        const row = rc ? rowOfClientY(view, (rc.top + rc.bottom) / 2, placement) : null
        if (row !== null) return row
      } catch {
        // fall through
      }
    }
    // No painted caret to read (focus elsewhere, or between two elements): the caret sits on the line
    // of the content just before it (a line end, or a footnote reference starting the page).
    try {
      const c = view.coordsAtPos(head, -1)
      const row = rowOfClientY(view, (c.top + c.bottom) / 2, placement)
      if (row !== null) return row
    } catch {
      // fall through
    }
    return placement.rowOf(page - 1)
  }
  return placement.rowOf(page)
}

/** Zoomed in, the spread can be taller than the window: scroll the caret into it (Book mode). */
function keepCaretInScroller(view: EditorView, scroller: HTMLElement | null) {
  if (!scroller || scroller.scrollHeight <= scroller.clientHeight + 1) return
  try {
    keepRectInScroller(view.coordsAtPos(view.state.selection.head), scroller)
  } catch {
    // No layout: nothing to scroll.
  }
}

function keepRectInScroller(c: { top: number; bottom: number }, scroller: HTMLElement | null) {
  if (!scroller || scroller.scrollHeight <= scroller.clientHeight + 1) return
  const r = scroller.getBoundingClientRect()
  const margin = 24
  if (c.top < r.top + margin) scroller.scrollTop -= r.top + margin - c.top
  else if (c.bottom > r.bottom - margin) scroller.scrollTop += c.bottom - (r.bottom - margin)
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
  const caretAt = (px: number): [Node | null, number] => {
    const p = doc.caretPositionFromPoint?.(px, y)
    if (p) return [p.offsetNode, p.offset]
    const r = doc.caretRangeFromPoint?.(px, y)
    return r ? [r.startContainer, r.startOffset] : [null, 0]
  }
  let [node, offset] = caretAt(x)
  // Past the end of a short line the browser can answer from the block's layout box rather than its
  // painted lines (a paragraph's continued lines are moved to a later page; with Book mode's clip the
  // rest of the paragraph is not even on screen): a position on another line, or the block element.
  // Then clamp x to the text painted on that line and ask again.
  const onTargetLine = (n: Node, o: number) => {
    if (n.nodeType !== Node.TEXT_NODE) return false
    try {
      const r = doc.createRange()
      r.setStart(n, o)
      r.collapse(true)
      const rc = Array.from(r.getClientRects()).find((q) => q.height > 0)
      return !rc || (rc.top - 1 <= y && rc.bottom + 1 >= y)
    } catch {
      return true
    }
  }
  if (node && node !== view.dom && view.dom.contains(node) && !onTargetLine(node, offset)) {
    let block: Element | null = node instanceof Element ? node : node.parentElement
    while (block && block.parentElement && block.parentElement !== view.dom) block = block.parentElement
    if (block) {
      const range = doc.createRange()
      range.selectNodeContents(block)
      const onLine = Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.top <= y && r.bottom >= y)
      if (onLine.length) {
        const left = Math.min(...onLine.map((r) => r.left))
        const right = Math.max(...onLine.map((r) => r.right))
        const cx = Math.min(right - 1, Math.max(left + 1, x))
        if (cx !== x) [node, offset] = caretAt(cx)
      }
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
function moveLineAcrossPages(view: EditorView, dir: 1 | -1, extend: boolean, ensurePageShown: (page: number) => void): boolean {
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
  // Book mode: the browser hit-tests only what is painted, and only one spread is. Turn to the
  // target page's spread first (the caret goes there anyway).
  ensurePageShown(q)
  rect = root.getBoundingClientRect()
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
  const px = rect.left + x * s
  const py = rect.top + ty * s
  let hit = posAtPaintedPoint(view, px, py)
  // The browser's answer past the end of a short line can be on another line (a paragraph continued
  // from the page before: its layout box is not where the line is painted). Then walk the target line
  // itself, from the page edge, for the position painted nearest to x.
  if (hit === null || !paintedOnLine(view, hit, py)) hit = nearestOnLine(view, dir > 0 ? pages[q].from : pages[q].to, dir, px, py) ?? hit
  if (hit === null) return false
  const $pos = view.state.doc.resolve(hit)
  const sel = extend ? extendTo(view.state.doc, view.state.selection.anchor, $pos.pos, dir) : TextSelection.near($pos)
  view.dispatch(view.state.tr.setSelection(sel).scrollIntoView())
  if (!extend && dir > 0) caretToPageStart(view, pages[q].from)
  return true
}

/** The caret at `pos` is painted on the line through client y. */
function paintedOnLine(view: EditorView, pos: number, y: number): boolean {
  try {
    const c = view.coordsAtPos(pos, 1)
    return c.top - 1 <= y && c.bottom + 1 >= y
  } catch {
    return false
  }
}

/**
 * The position on the painted line through client y nearest to x, walking from `edge` (a page's
 * first position going forward, or its last going back) while the positions stay on that line.
 */
function nearestOnLine(view: EditorView, edge: number, dir: 1 | -1, x: number, y: number): number | null {
  const size = view.state.doc.content.size
  let best: number | null = null
  let bestD = Infinity
  let seen = false
  for (let i = 0, pos = Math.max(0, Math.min(size, edge)); i < 400 && pos >= 0 && pos <= size; i++, pos += dir) {
    let c: { left: number; top: number; bottom: number }
    try {
      c = view.coordsAtPos(pos, dir > 0 ? 1 : -1)
    } catch {
      continue
    }
    const on = c.top - 1 <= y && c.bottom + 1 >= y
    if (!on) {
      if (seen) break
      continue
    }
    seen = true
    const d = Math.abs(c.left - x)
    if (d < bestD) {
      bestD = d
      best = pos
    }
  }
  return best === null ? null : TextSelection.near(view.state.doc.resolve(best)).head
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
