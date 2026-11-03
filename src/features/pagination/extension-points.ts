import type { Node as PMNode } from '@tiptap/pm/model'
import type { ReactNode } from 'react'
import { useSyncExternalStore } from 'react'
import type { PageInfo } from '@/shared/store'
import type { PageGeometry } from './geometry'

/**
 * Extension points other slices fill (docs/pagination.md, "Extension points"):
 *  (a) page slots: render-props for the header and footer regions inside each page's margins;
 *  (b) bottom reservations: px a page keeps free at its bottom (footnotes), pushing body text on;
 *  (c) the chapter predicate that numbers `PageInfo.chapterIndex`.
 * Registries are module-level (one editor per window). Every register* returns its unregister.
 */

// ---- (a) Header / footer slots ---------------------------------------------------------------

export type PageSlotRegion = 'header' | 'footer'

export interface PageSlotContext {
  page: PageInfo
  pageCount: number
  geometry: PageGeometry
  /** Size of the region (px, unscaled): the text block width, and the top / bottom margin height. */
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
 * Call `invalidatePagination()` when the answer changes for another reason (e.g. a footnote edited).
 */
export function registerBottomReservation(id: string, reserve: BottomReservation): () => void {
  reservations.set(id, reserve)
  invalidatePagination()
  return () => {
    if (reservations.get(id) !== reserve) return
    reservations.delete(id)
    invalidatePagination()
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

/** Whether a top-level block opens a chapter. Default: a level-1 heading. */
export type ChapterPredicate = (node: PMNode) => boolean

export const defaultChapterPredicate: ChapterPredicate = (node) => node.type.name === 'heading' && node.attrs.level === 1

let chapterPredicate: ChapterPredicate = defaultChapterPredicate

/** Replace the chapter predicate (the chapters ticket); `null` restores the default. Reflows. */
export function setChapterPredicate(predicate: ChapterPredicate | null): void {
  chapterPredicate = predicate ?? defaultChapterPredicate
  invalidatePagination()
}

export function isChapterStart(node: PMNode): boolean {
  return chapterPredicate(node)
}

// ---- Invalidation ----------------------------------------------------------------------------

/**
 * Re-measure and reflow everything on the next frame. For changes the engine cannot see: a style
 * sheet that changes block metrics without changing the document, a `data-break-before` attribute
 * emitted by a decoration, a reservation whose answer changed.
 */
export function invalidatePagination(): void {
  layoutListeners.forEach((l) => l())
}

/** Internal: the engine listens for invalidations. */
export function onInvalidate(cb: () => void): () => void {
  layoutListeners.add(cb)
  return () => layoutListeners.delete(cb)
}
