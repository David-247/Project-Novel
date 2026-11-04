import type { BookView } from '@/shared/book'
import type { SliceCreator } from './types'

/**
 * Pagination layout model (Phase 2). Published by the pagination slice after every reflow; read by
 * the page indicator, headers/footers and footnotes. Documented in docs/pagination.md.
 *
 * Doc positions follow ProseMirror: pages tile the document as half-open ranges `[from, to)`;
 * page 0 starts at 0 and the last page ends at `doc.content.size`. A page that starts with a
 * block starts at that block's position (just before the node); a page that starts mid-paragraph
 * starts at the first character of its first line. A blank page (left by a recto break) has
 * `from === to`.
 */
export type PageSide = 'verso' | 'recto'

export interface PageInfo {
  /** 0-based. Page 0 is a recto (right-hand page), like the first page of a printed book. */
  index: number
  side: PageSide
  from: number
  to: number
  /** No content: a verso left empty so the next block can start on a recto. */
  isBlank: boolean
  /** Node type name of the block that begins at the top of this page, or null when the page
   *  starts in the middle of a block (or is blank). */
  startsBlockType: string | null
  /** 0-based index of the chapter this page belongs to (-1 before the first chapter opening). */
  chapterIndex: number
}

/** The spread most visible in the window. In single-page view a "spread" is one page. */
export interface VisibleSpread {
  index: number
  /** First and last page index shown in it (inclusive). */
  first: number
  last: number
}

export type ZoomMode = 'fit-spread' | 'fit-width' | 'percent'

export interface LayoutSlice {
  layout: {
    pageCount: number
    pages: PageInfo[]
    /** Page holding the selection head. */
    currentPage: number
    visibleSpread: VisibleSpread
    /** What is shown: 'single' when book.view is 'single' or the window is too narrow for two pages. */
    effectiveView: BookView
    /** Zoom choice; `percent` is the user's percentage in 'percent' mode. */
    zoom: { mode: ZoomMode; percent: number }
    /** Scale actually applied (fit modes resolve to a number), for the zoom control's label. */
    scale: number
    /** Increments on every published reflow. */
    layoutVersion: number
  }
  layoutActions: {
    /** Publish a new page model (pageCount follows pages.length). */
    setPages: (pages: PageInfo[]) => void
    setCurrentPage: (index: number) => void
    setVisibleSpread: (spread: VisibleSpread) => void
    setEffectiveView: (view: BookView) => void
    setZoom: (zoom: { mode: ZoomMode; percent?: number }) => void
    setScale: (scale: number) => void
    /** Back to an empty model (no editor mounted). */
    resetLayout: () => void
  }
}

const initialLayout = (): LayoutSlice['layout'] => ({
  pageCount: 0,
  pages: [],
  currentPage: 0,
  visibleSpread: { index: 0, first: 0, last: 0 },
  effectiveView: 'spread',
  zoom: { mode: 'fit-spread', percent: 100 },
  scale: 1,
  layoutVersion: 0,
})

export const createLayoutSlice: SliceCreator<LayoutSlice> = (set) => ({
  layout: initialLayout(),
  layoutActions: {
    setPages: (pages) =>
      set((s) => ({
        layout: { ...s.layout, pages, pageCount: pages.length, layoutVersion: s.layout.layoutVersion + 1 },
      })),
    setCurrentPage: (currentPage) =>
      set((s) => (s.layout.currentPage === currentPage ? s : { layout: { ...s.layout, currentPage } })),
    setVisibleSpread: (v) =>
      set((s) => {
        const o = s.layout.visibleSpread
        return o.index === v.index && o.first === v.first && o.last === v.last ? s : { layout: { ...s.layout, visibleSpread: v } }
      }),
    setEffectiveView: (effectiveView) =>
      set((s) => (s.layout.effectiveView === effectiveView ? s : { layout: { ...s.layout, effectiveView } })),
    setZoom: ({ mode, percent }) =>
      set((s) => ({ layout: { ...s.layout, zoom: { mode, percent: percent ?? s.layout.zoom.percent } } })),
    setScale: (scale) => set((s) => (s.layout.scale === scale ? s : { layout: { ...s.layout, scale } })),
    resetLayout: () => set((s) => ({ layout: { ...initialLayout(), zoom: s.layout.zoom, layoutVersion: s.layout.layoutVersion + 1 } })),
  },
})
