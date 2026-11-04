import type { Node as PMNode } from '@tiptap/pm/model'
import type { ReactNode } from 'react'
import { useSyncExternalStore } from 'react'
import { getChapters } from '@/features/editor'
import type { PageInfo } from '@/shared/store'
import type { PageGeometry } from './geometry'

/**
 * Extension points other slices fill (docs/pagination.md, "Extension points"):
 *  (a) page slots: render-props for the header and footer regions inside each page's margins;
 *  (b) bottom reservations: px a page keeps free at its bottom (footnotes), pushing body text on;
 *  (c) the chapter model that numbers `PageInfo.chapterIndex` (default: the editor's getChapters).
 * Registries are module-level (one editor per window). Every register* returns its unregister.
 */

// ---- (a) Header / footer slots ---------------------------------------------------------------

/**
 * 'header' / 'footer': the top / bottom margin. 'reserved': the text block itself (behind the text),
 * for content drawn in the space a bottom reservation keeps free (footnotes): anchor it at the
 * bottom of the region and keep it no taller than the reservation.
 */
export type PageSlotRegion = 'header' | 'footer' | 'reserved'

export interface PageSlotContext {
  page: PageInfo
  pageCount: number
  geometry: PageGeometry
  /** Size of the region (px, unscaled): the text block width, and the top / bottom margin height
   *  (the text block height for 'reserved'). */
  width: number
  height: number
}

export interface PageSlot {
  /** Unique; registering the same id again replaces the earlier slot. */
  id: string
  region: PageSlotRegion
  /** Called for every rendered page, blank ones included (check `ctx.page.isBlank`). */
  render: (ctx: PageSlotContext) => ReactNode
  /** Lower first when several slots share a region (default 0). */
  order?: number
}

let slots: readonly PageSlot[] = []
const slotListeners = new Set<() => void>()

export function registerPageSlot(slot: PageSlot): () => void {
  slots = [...slots.filter((s) => s.id !== slot.id), slot].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
  slotListeners.forEach((l) => l())
  return () => {
    if (!slots.includes(slot)) return
    slots = slots.filter((s) => s !== slot)
    slotListeners.forEach((l) => l())
  }
}

function subscribeSlots(cb: () => void) {
  slotListeners.add(cb)
  return () => slotListeners.delete(cb)
}

/** All registered slots (re-renders when the registry changes). */
export function usePageSlots(): readonly PageSlot[] {
  return useSyncExternalStore(subscribeSlots, () => slots, () => slots)
}

// ---- (b) Bottom reservations -----------------------------------------------------------------

/** The candidate page a reservation is asked about (its range may still change). */
export interface ReservationPage {
  index: number
  side: PageInfo['side']
  from: number
  to: number
}

/** Px to keep free at the bottom of `page` (0 for none). Must not need more for fewer lines. */
export type BottomReservation = (page: ReservationPage) => number

const reservations = new Map<string, BottomReservation>()
const layoutListeners = new Set<() => void>()

/**
 * Register a bottom reservation. The engine refills a page with the summed reservation until it
 * converges (capped; see breaker.ts `MAX_RESERVE_ITERATIONS`). Registering or unregistering reflows.
 * Call `relayoutPagination()` when the answer changes for another reason (e.g. a footnote edited):
 * it re-breaks the pages from the measured lines without re-measuring anything.
 */
export function registerBottomReservation(id: string, reserve: BottomReservation): () => void {
  reservations.set(id, reserve)
  relayoutPagination()
  return () => {
    if (reservations.get(id) !== reserve) return
    reservations.delete(id)
    relayoutPagination()
  }
}

export function hasReservations(): boolean {
  return reservations.size > 0
}

/** Sum of all reservations for a page (non-finite or negative answers count as 0). */
export function totalReservation(page: ReservationPage): number {
  let sum = 0
  for (const r of reservations.values()) {
    const v = r(page)
    if (Number.isFinite(v) && v > 0) sum += v
  }
  return sum
}

// ---- (c) Chapters ----------------------------------------------------------------------------

/** Whether a top-level block opens a chapter (an override of the default chapter model). */
export type ChapterPredicate = (node: PMNode) => boolean

/**
 * Default chapter model: the editor's `getChapters` (breaks ticket). A chapter opens at a Chapter
 * Title block (an unstyled level-1 heading is one), or at the Chapter Number directly before it.
 * Content before the first opening is front matter (chapterIndex -1).
 */
export const defaultChapterOpenings = (doc: PMNode): number[] => getChapters(doc).map((c) => c.from)

let chapterPredicate: ChapterPredicate | null = null

/** Replace the chapter model by a per-block predicate; `null` restores the default model. Re-breaks. */
export function setChapterPredicate(predicate: ChapterPredicate | null): void {
  chapterPredicate = predicate
  relayoutPagination()
}

/** Positions of the top-level blocks that open a chapter, in document order. */
export function chapterOpenings(doc: PMNode): number[] {
  if (!chapterPredicate) return defaultChapterOpenings(doc)
  const out: number[] = []
  doc.forEach((node, pos) => {
    if (chapterPredicate!(node)) out.push(pos)
  })
  return out
}

// ---- Invalidation ----------------------------------------------------------------------------

/**
 * Re-measure and reflow everything on the next frame. For changes the engine cannot see that alter
 * block metrics: a style sheet that changes line heights without changing the document, a font.
 * (The engine already follows book.styles itself.) Costly on a long book: prefer
 * `relayoutPagination()` when no line box changed.
 */
export function invalidatePagination(): void {
  layoutListeners.forEach((l) => l())
}

/**
 * Re-break the pages on the next frame from the lines already measured (no re-measuring): for a
 * bottom reservation whose answer changed, a `data-break-before` attribute added or removed by a
 * decoration, or a new chapter predicate. About the cost of a keystroke.
 */
export function relayoutPagination(): void {
  relayoutListeners.forEach((l) => l())
}

const relayoutListeners = new Set<() => void>()

/**
 * Re-measure only the top-level blocks containing `positions` (document positions), then reflow,
 * on the next frame. For a decoration that changes a block's line boxes without a document change
 * (a footnote reference whose derived number got wider). About a keystroke's cost per block.
 */
export function invalidatePaginationAt(positions: readonly number[]): void {
  if (positions.length) blockListeners.forEach((l) => l(positions))
}

const blockListeners = new Set<(positions: readonly number[]) => void>()

/** Internal: the engine listens for block re-measure requests. */
export function onInvalidateBlocks(cb: (positions: readonly number[]) => void): () => void {
  blockListeners.add(cb)
  return () => blockListeners.delete(cb)
}

/** Internal: the engine listens for invalidations. */
export function onInvalidate(cb: () => void): () => void {
  layoutListeners.add(cb)
  return () => layoutListeners.delete(cb)
}

/** Internal: the engine listens for relayout requests. */
export function onRelayout(cb: () => void): () => void {
  relayoutListeners.add(cb)
  return () => relayoutListeners.delete(cb)
}
