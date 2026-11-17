import type { BookView } from '@/shared/book'
import { sideOf } from './breaker'
import type { PageGeometry } from './geometry'

/**
 * Where pages sit on the canvas (unscaled px). Pure.
 *
 * Spread view: rows of two pages that touch at the spine, verso left and recto right. Page 0 is a
 * recto alone in row 0 (like the first page of a printed book); row r >= 1 holds pages 2r-1 and 2r.
 * Single view: one page per row. Margins mirror: a verso has its outside margin on the left and the
 * inside (binding) margin on the right; a recto the other way round.
 */
export const DESK_PAD = 32
export const ROW_GAP = 32

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface Placement {
  view: BookView
  pageCount: number
  rowCount: number
  canvasWidth: number
  canvasHeight: number
  rowOf: (page: number) => number
  /** First and last page index in a row (inclusive). */
  pagesInRow: (row: number) => [number, number]
  /** Row whose band contains canvas y (clamped). */
  rowAtY: (y: number) => number
  rowTop: (row: number) => number
  frame: (page: number) => Rect
  /** Top-left of the page's text block. */
  content: (page: number) => { x: number; y: number }
}

export function placePages(pageCount: number, g: PageGeometry, view: BookView): Placement {
  const count = Math.max(1, pageCount)
  const W = g.pageWidth
  const H = g.pageHeight
  const spread = view === 'spread'
  const rowOf = (i: number) => (spread ? Math.floor((i + 1) / 2) : i)
  const rowCount = rowOf(count - 1) + 1
  const rowTop = (r: number) => DESK_PAD + r * (H + ROW_GAP)
  const frame = (i: number): Rect => {
    const x = spread ? (sideOf(i) === 'verso' ? DESK_PAD : DESK_PAD + W) : DESK_PAD
    return { x, y: rowTop(rowOf(i)), width: W, height: H }
  }
  return {
    view,
    pageCount,
    rowCount,
    canvasWidth: (spread ? 2 * W : W) + 2 * DESK_PAD,
    canvasHeight: 2 * DESK_PAD + rowCount * H + (rowCount - 1) * ROW_GAP,
    rowOf,
    pagesInRow: (r) => {
      if (!spread) return [r, r]
      if (r <= 0) return [0, 0]
      return [2 * r - 1, Math.min(2 * r, count - 1)]
    },
    rowAtY: (y) => Math.min(rowCount - 1, Math.max(0, Math.floor((y - DESK_PAD + ROW_GAP / 2) / (H + ROW_GAP)))),
    rowTop,
    frame,
    content: (i) => {
      const f = frame(i)
      return { x: f.x + (sideOf(i) === 'verso' ? g.margins.outside : g.margins.inside), y: f.y + g.margins.top }
    },
  }
}

/** Number of rows (spreads, or pages in single view) for `pageCount` pages: same as placePages(...).rowCount. */
export function rowCountFor(pageCount: number, view: BookView): number {
  const count = Math.max(1, pageCount)
  return view === 'spread' ? Math.floor(count / 2) + 1 : count
}

/**
 * Book mode (page-turn navigation): the canvas shows one row only, clipped to it. Its height on the
 * canvas, desk padding above and below included (the gap between rows equals the padding).
 */
export function bookRowHeight(g: PageGeometry): number {
  return g.pageHeight + 2 * DESK_PAD
}

/** Width kept free on each side of the spread in Book mode for the page-turn controls (px, unscaled by zoom). */
export const TURN_LANE = 48

/** Width the spread needs at `scale` before the view falls back to single pages. */
export const MIN_READABLE_SPREAD_SCALE = 0.75

/** 'single' when asked for, or when two pages would not fit `availableWidth` at a readable scale. */
export function effectiveView(requested: BookView, availableWidth: number, g: PageGeometry): BookView {
  if (requested === 'single') return 'single'
  if (availableWidth <= 0) return 'spread'
  const spreadWidth = 2 * g.pageWidth + 2 * DESK_PAD
  return availableWidth / spreadWidth < MIN_READABLE_SPREAD_SCALE ? 'single' : 'spread'
}

export const ZOOM_STEPS = [50, 75, 100, 125, 150, 200] as const
export const MIN_SCALE = 0.25
export const MAX_SCALE = 4

/** Scale for a zoom choice, given the scroll viewport size. */
export function resolveScale(
  zoom: { mode: 'fit-spread' | 'fit-width' | 'percent'; percent: number },
  viewport: { width: number; height: number },
  placement: Pick<Placement, 'canvasWidth'>,
  g: PageGeometry,
): number {
  let s: number
  if (zoom.mode === 'percent') s = zoom.percent / 100
  else if (viewport.width <= 0) s = 1
  else {
    const fitW = viewport.width / placement.canvasWidth
    s = zoom.mode === 'fit-width' || viewport.height <= 0 ? fitW : Math.min(fitW, viewport.height / (g.pageHeight + 2 * DESK_PAD))
  }
  return Math.round(Math.min(MAX_SCALE, Math.max(MIN_SCALE, s)) * 1000) / 1000
}

/** Next zoom step above (dir 1) or below (dir -1) the current scale, as a percentage. */
export function stepZoom(scale: number, dir: 1 | -1): number {
  const pct = Math.round(scale * 100)
  if (dir > 0) return ZOOM_STEPS.find((z) => z > pct) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1]
  return [...ZOOM_STEPS].reverse().find((z) => z < pct) ?? ZOOM_STEPS[0]
}
