import type { PageInfo, VisibleSpread } from '@/shared/store'

/** Vertical space between stacked cards (px). */
export const CARD_GAP = 8

export interface CardBox {
  /** Where the card wants its top: level with its anchor's line (px, panel coordinates). */
  desired: number
  height: number
}

/**
 * Card tops for the margin panel (pure). Items are in anchor order. Each card sits level with its
 * anchor; when cards would overlap they stack downward. The active card (index `active`, or -1) is
 * pulled to its anchor and the cards above it stack upward from it, as in Word and Google Docs. If
 * that would push a card above the top, everything is laid out downward from the top instead.
 */
export function stackCards(items: readonly CardBox[], active = -1, gap = CARD_GAP): number[] {
  const tops = items.map((c) => Math.max(0, c.desired))
  const down = (from: number) => {
    for (let i = Math.max(1, from); i < items.length; i++) {
      tops[i] = Math.max(tops[i], tops[i - 1] + items[i - 1].height + gap)
    }
  }
  if (active < 0 || active >= items.length) {
    down(1)
    return tops
  }
  down(active + 1)
  for (let i = active - 1; i >= 0; i--) {
    tops[i] = Math.min(tops[i], tops[i + 1] - items[i].height - gap)
  }
  if (tops[0] < 0) {
    tops[0] = 0
    down(1)
  }
  return tops
}

/**
 * Document range of the spread in view: comments anchored there are shown in the margin panel
 * (Book mode shows the visible spread's comments only). Null when there is no page model yet.
 */
export function spreadRange(pages: readonly PageInfo[], spread: VisibleSpread): { from: number; to: number } | null {
  if (!pages.length) return null
  const first = pages[Math.min(spread.first, pages.length - 1)]
  const last = pages[Math.min(spread.last, pages.length - 1)]
  if (!first || !last) return null
  // The last page of the book ends at the document end: include it.
  const to = last.index === pages.length - 1 ? Number.POSITIVE_INFINITY : last.to
  return { from: first.from, to }
}

/** An anchor starting in `range` (half-open; the end of the book included). */
export function inRange(from: number, range: { from: number; to: number } | null): boolean {
  return !range || (from >= range.from && from < range.to)
}

/** Width of the margin panel (px). */
export const PANEL_WIDTH = 304
/** Same rule as the pagination slice's narrow fallback: a page below 75 % scale is not readable. */
const MIN_READABLE_SCALE = 0.75
const DESK_PADDING = 64

/** The window is too narrow for the pages plus the panel: use the drawer. */
export function needsDrawer(hostWidth: number, pageWidth: number, view: 'spread' | 'single'): boolean {
  if (hostWidth <= 0) return false
  const pagesWidth = (view === 'spread' ? 2 : 1) * pageWidth * MIN_READABLE_SCALE + DESK_PADDING
  return hostWidth - PANEL_WIDTH < pagesWidth
}
