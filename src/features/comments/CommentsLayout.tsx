import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import { pageBox } from '@/shared/book'
import { useStore } from '@/shared/store'
import { cn, IconButton, ToggleButton, Tooltip } from '@/shared/ui'
import { nextComment, prevComment, redoInManuscript, setCommentsNarrow, shownAnchors, toggleShowResolved, undoInManuscript } from './commands'
import { COMMENT_CONTROLS as C } from './controls'
import { collectAnchors } from './anchors'
import { commentsKey, getCommentsView } from './extension'
import { buildHighlightCss } from './highlight'
import { ChevronDownIcon, ChevronUpIcon, CloseIcon, ResolvedIcon } from './icons'
import { inRange, needsDrawer, PANEL_WIDTH, spreadRange, stackCards } from './layout'
import type { CommentThread } from './model'
import { DraftCard, ThreadCard } from './ThreadCard'
import './comments.css'

/** Narrow widths where the drawer becomes a bottom sheet (touch widths). */
const SHEET_MAX_WIDTH = 640

interface ShownItem {
  key: string
  from: number
  thread: CommentThread | null
}

/** Last panel layout (e2e / perf). */
export const commentsDebug = { lastLayoutMs: 0, layouts: 0, laidOutVersion: -1, laidOutAt: 0 }

/** Threads shown (anchored, resolved only with Show Resolved), in document order. */
function useShownItems(rangeFilter: boolean, includeResolved = false): ShownItem[] {
  const threads = useStore((s) => s.comments.threads)
  const showResolved = useStore((s) => s.comments.showResolved) || includeResolved
  const draft = useStore((s) => s.comments.draft)
  // The anchors follow the document: recomputed per change (cached per block; no doc scan).
  const docVersion = useStore((s) => s.editor.docVersion)
  const pages = useStore((s) => s.layout.pages)
  const spread = useStore((s) => s.layout.visibleSpread)
  return useMemo(() => {
    void docVersion
    const v = getCommentsView()
    if (!v) return []
    const byId = new Map(threads.map((t) => [t.id, t]))
    const range = rangeFilter ? spreadRange(pages, spread) : null
    const items: ShownItem[] = shownAnchors(v.state, showResolved)
      .filter((a) => byId.has(a.id) && inRange(a.from, range))
      .map((a) => ({ key: a.id, from: a.from, thread: byId.get(a.id)! }))
    if (draft) {
      const at = items.findIndex((i) => i.from > draft.from)
      items.splice(at < 0 ? items.length : at, 0, { key: 'draft', from: draft.from, thread: null })
    }
    return items
  }, [threads, showResolved, draft, docVersion, pages, spread, rangeFilter])
}

/**
 * Any thread anchored anywhere in the manuscript, resolved ones included (the panel takes room only
 * then; it stays while every comment is resolved, so Show Resolved remains at hand).
 */
function useHasComments(): boolean {
  const all = useShownItems(false, true)
  return all.length > 0
}

/** The anchor highlight style sheet (highlight.ts), kept in sync without re-rendering React. */
function useCommentHighlights() {
  useEffect(() => {
    const style = document.createElement('style')
    style.setAttribute('data-nv-comment-highlights', '')
    document.head.appendChild(style)
    let last = ''
    const update = () => {
      const c = useStore.getState().comments
      const root = getComputedStyle(document.documentElement)
      const css = buildHighlightCss({
        threads: c.threads,
        activeId: c.activeId,
        hoverId: c.hoverId,
        showResolved: c.showResolved,
        pageBg: root.getPropertyValue('--page-bg').trim() || null,
        pageFg: root.getPropertyValue('--page-fg').trim() || null,
      })
      if (css !== last) style.textContent = last = css
    }
    update()
    const unsub = useStore.subscribe((s, p) => {
      const a = s.comments
      const b = p.comments
      if (a.threads !== b.threads || a.activeId !== b.activeId || a.hoverId !== b.hoverId || a.showResolved !== b.showResolved) update()
    })
    // The paper (and so the author-colour mix) changes with data-surface / data-theme.
    const mo = new MutationObserver(update)
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-surface', 'data-theme'] })
    return () => {
      unsub()
      mo.disconnect()
      style.remove()
    }
  }, [])
}

/** Mod-z / Mod-Shift-z / Mod-y in the panel (outside its text fields) undo in the manuscript. */
function onPanelKeyDown(e: KeyboardEvent) {
  const t = e.target as HTMLElement
  if (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT') return
  if (!(e.metaKey || e.ctrlKey) || e.altKey) return
  const k = e.key.toLowerCase()
  if (k === 'z' && !e.shiftKey) {
    e.preventDefault()
    undoInManuscript()
  } else if ((k === 'z' && e.shiftKey) || k === 'y') {
    e.preventDefault()
    redoInManuscript()
  }
}

function PanelHeader({ onClose }: { onClose?: () => void }) {
  const showResolved = useStore((s) => s.comments.showResolved)
  return (
    <div className="flex items-center gap-1 border-b border-border bg-bg px-2 py-1">
      <h2 className="flex-1 px-1 text-ui font-semibold text-text">Comments</h2>
      <Tooltip side="bottom">
        <IconButton label={C.prev.label} data-control-id={C.prev.id} onClick={() => prevComment()}>
          <ChevronUpIcon />
        </IconButton>
      </Tooltip>
      <Tooltip side="bottom">
        <IconButton label={C.next.label} data-control-id={C.next.id} onClick={() => nextComment()}>
          <ChevronDownIcon />
        </IconButton>
      </Tooltip>
      <Tooltip side="bottom">
        <ToggleButton label={C.showResolved.label} data-control-id={C.showResolved.id} pressed={showResolved} onPressedChange={() => toggleShowResolved()}>
          <ResolvedIcon />
        </ToggleButton>
      </Tooltip>
      {onClose ? (
        <Tooltip side="bottom">
          <IconButton label={C.drawerClose.label} data-control-id={C.drawerClose.id} onClick={onClose}>
            <CloseIcon />
          </IconButton>
        </Tooltip>
      ) : null}
    </div>
  )
}

function Card({ item }: { item: ShownItem }) {
  const active = useStore((s) => item.thread !== null && s.comments.activeId === item.thread.id)
  const lit = useStore((s) => item.thread !== null && s.comments.hoverId === item.thread.id)
  return item.thread ? <ThreadCard thread={item.thread} active={active} lit={lit} /> : <DraftCard />
}

/**
 * The margin panel: to the right of the pages, on the desk. Each card sits level with its anchor's
 * line (painted position, so page offsets and zoom are included) and cards stack downward without
 * overlapping; the active card is pulled to its anchor. Only the visible spread's comments are shown
 * (layout slice `visibleSpread` + `pages`, never the scroll position), and positions are recomputed
 * on every published reflow (`layoutVersion`), zoom and spread change.
 */
function MarginPanel() {
  const items = useShownItems(true)
  const activeId = useStore((s) => s.comments.activeId)
  const layoutVersion = useStore((s) => s.layout.layoutVersion)
  const scale = useStore((s) => s.layout.scale)
  const cardsRef = useRef<HTMLDivElement>(null)
  const frame = useRef(0)

  const layout = useRef(() => {})
  // The latest layout function (it reads this render's items), set before the effects below run.
  useLayoutEffect(() => {
    layout.current = () => {
      const box = cardsRef.current
      const v = getCommentsView()
      if (!box || !v) return
      const t0 = performance.now()
      const top0 = box.getBoundingClientRect().top
      const els = Array.from(box.children) as HTMLElement[]
      // Positions now (typing before an anchor moves it without re-rendering the cards).
      const anchors = collectAnchors(v.state.doc)
      const draftNow = commentsKey.getState(v.state)?.draft ?? null
      const boxes = els.map((el, i) => {
        const item = items[i]
        const from = item ? (item.thread ? anchors.get(item.key)?.from : draftNow?.from) : undefined
        let desired = 0
        try {
          if (from !== undefined) desired = v.coordsAtPos(Math.min(from, v.state.doc.content.size), 1).top - top0
        } catch {
          desired = 0
        }
        return { desired: Number.isFinite(desired) ? desired : 0, height: el.offsetHeight }
      })
      const activeIndex = items.findIndex((i) => (activeId ? i.key === activeId : i.key === 'draft'))
      const tops = stackCards(boxes, activeIndex)
      els.forEach((el, i) => {
        el.style.transform = `translateY(${Math.round(tops[i])}px)`
        el.dataset.top = String(Math.round(tops[i]))
        el.dataset.anchorTop = String(Math.round(boxes[i].desired))
      })
      commentsDebug.lastLayoutMs = performance.now() - t0
      commentsDebug.layouts++
      commentsDebug.laidOutVersion = useStore.getState().layout.layoutVersion
      commentsDebug.laidOutAt = performance.now()
      box.dataset.layoutVersion = String(commentsDebug.laidOutVersion)
    }
  })

  // After every render that can move an anchor: the reflow is already laid out and painted.
  // Which cards, not where their anchors are: typing re-renders the panel without a relayout; the
  // reflow that follows (layoutVersion) moves the cards.
  const cardsKey = items.map((i) => i.key).join(' ')
  // Positions are read in a microtask: after the pagination pass that published the layout has
  // finished writing the DOM (a commit can run in the middle of it), so the read does not force a
  // layout the pass then invalidates again, and still before that frame is painted.
  const placeQueued = useRef(false)
  useLayoutEffect(() => {
    if (placeQueued.current) return
    placeQueued.current = true
    queueMicrotask(() => {
      placeQueued.current = false
      layout.current()
    })
  }, [cardsKey, activeId, layoutVersion, scale])

  // A card that grows or shrinks (reply field opened, text typed) restacks the others.
  useEffect(() => {
    const box = cardsRef.current
    if (!box) return
    const ro = new ResizeObserver(() => {
      if (!frame.current) {
        frame.current = requestAnimationFrame(() => {
          frame.current = 0
          layout.current()
        })
      }
    })
    for (const el of Array.from(box.children)) ro.observe(el)
    return () => {
      ro.disconnect()
      if (frame.current) cancelAnimationFrame(frame.current)
      frame.current = 0
    }
  }, [cardsKey])

  return (
    <aside
      aria-label="Comments"
      className="nv-comments-panel relative shrink-0 border-l border-border bg-desk [contain:layout_style]"
      style={{ width: PANEL_WIDTH }}
      data-testid="comments-panel"
      onKeyDown={onPanelKeyDown}
    >
      <div className="sticky top-0 z-10">
        <PanelHeader />
      </div>
      {/* Out of flow (a zero-height anchor): moving or resizing cards never relays out the pages beside. */}
      <div className="relative h-0">
        <div ref={cardsRef} className="nv-comment-cards absolute inset-x-3 top-0" data-testid="comment-cards">
          {items.map((item) => (
            <div key={item.key} className="nv-comment-slot absolute inset-x-0 top-0" data-slot={item.key}>
              <Card item={item} />
            </div>
          ))}
        </div>
      </div>
    </aside>
  )
}

/** Narrow windows: the threads in document order in a side drawer (a bottom sheet on touch widths). */
function CommentsDrawer({ sheet }: { sheet: boolean }) {
  const items = useShownItems(false)
  const close = () => useStore.getState().commentsActions.setDrawerOpen(false)
  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-label="Comments"
      data-testid="comments-drawer"
      data-sheet={sheet || undefined}
      onKeyDown={(e) => {
        if (e.key === 'Escape') close()
        else onPanelKeyDown(e)
      }}
      className={cn(
        'fixed z-40 flex flex-col border-border bg-bg text-text shadow-raised',
        sheet ? 'inset-x-0 bottom-0 max-h-[60vh] rounded-t-panel border-t' : 'bottom-0 right-0 top-0 w-[min(22rem,100vw)] border-l',
      )}
    >
      <PanelHeader onClose={close} />
      <ol className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
        {items.length === 0 ? <li className="text-ui-sm text-text-muted">No comments.</li> : null}
        {items.map((item) => (
          <li key={item.key}>
            <Card item={item} />
          </li>
        ))}
      </ol>
    </div>
  )
}

/**
 * Hosts the pages (children: the paginated view) and the comments beside them: the margin panel in
 * a window wide enough for the pages plus the panel, otherwise a toggleable drawer. Also keeps the
 * anchor highlight style sheet in sync.
 */
export function CommentsLayout({ children }: { children: ReactNode }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const trimSize = useStore((s) => s.book.trimSize)
  const margins = useStore((s) => s.book.margins)
  const view = useStore((s) => s.book.view)
  const panelOpen = useStore((s) => s.comments.panelOpen)
  const drawerOpen = useStore((s) => s.comments.drawerOpen)
  const hasDraft = useStore((s) => s.comments.draft !== null)
  const hasComments = useHasComments()
  useCommentHighlights()

  useLayoutEffect(() => {
    const el = hostRef.current
    if (!el) return
    const measure = () => setWidth(el.clientWidth)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const pageWidth = useMemo(() => pageBox(trimSize, margins).page.width, [trimSize, margins])
  const narrow = needsDrawer(width, pageWidth, view)
  useEffect(() => setCommentsNarrow(narrow), [narrow])
  // A composer opened in a narrow window opens the drawer.
  useEffect(() => {
    if (narrow && hasDraft) useStore.getState().commentsActions.setDrawerOpen(true)
  }, [narrow, hasDraft])

  return (
    <div ref={hostRef} className="nv-comments-host flex min-h-full items-stretch" data-comments-layout={narrow ? 'drawer' : 'margin'}>
      <div className="min-w-0 flex-1">{children}</div>
      {!narrow && panelOpen && (hasComments || hasDraft) ? <MarginPanel /> : null}
      {narrow && drawerOpen ? <CommentsDrawer sheet={width > 0 && width < SHEET_MAX_WIDTH} /> : null}
    </div>
  )
}

/** For tests: is the comments plugin state reachable? */
export const hasCommentsPlugin = () => {
  const v = getCommentsView()
  return !!v && !!commentsKey.getState(v.state)
}
