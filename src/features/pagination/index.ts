// Public interface of the "pagination" slice (docs/pagination.md). Other slices import ONLY from here.
//
// View: <PaginatedView> hosts the editor's single view (<NovelEditor paged />) and lays it out as
// pages; <PageIndicator> and <ZoomControls> go in the status bar.
// Model: the shared store's `layout` slice (pages, currentPage, visibleSpread, ...).
// Extension points: header/footer page slots, bottom reservations (footnotes), the chapter
// predicate, invalidatePagination() (re-measure) and relayoutPagination() (re-break only).
// Break contract: block attr `breakBefore: 'page' | 'recto'`, or DOM attr `data-break-before` on
// the block's top-level element.
export { PaginatedView } from './PaginatedView'
// Navigation (both modes, docs/pagination.md "Navigation modes"): Go to Page; turn / jump spreads
// (view only, the caret stays); revealPosition(pos) brings a position into view (Book mode turns to
// its spread): use it after moving the selection to something (Next Comment, Next Change).
export { goToPage, turnSpread, goToEdgeSpread, showPage, revealPosition } from './navigation'
// View menu: Single Page / Two-Page Spread, zoom (shared command registry). Returns unregister.
export { registerPaginationCommands } from './commands'
export type { PaginatedViewProps } from './PaginatedView'
export { PageIndicator, ZoomControls, pageIndicatorText } from './StatusControls'
export { PAGINATION_CONTROLS } from './controls'
export type { PaginationControlMeta, PaginationControlKey } from './controls'
export {
  registerPageSlot,
  registerBottomReservation,
  setChapterPredicate,
  defaultChapterOpenings,
  invalidatePagination,
  invalidatePaginationAt,
  relayoutPagination,
} from './extension-points'
export type {
  PageSlot,
  PageSlotRegion,
  PageSlotContext,
  BottomReservation,
  ReservationPage,
  ChapterPredicate,
} from './extension-points'
export { resolvePageGeometry } from './geometry'
export type { PageGeometry } from './geometry'
export { breakPages, DEFAULT_WIDOWS, DEFAULT_ORPHANS, MAX_RESERVE_ITERATIONS } from './breaker'
export type { BreakBefore } from './breaker'
export { getPaginationDebug } from './debug'
