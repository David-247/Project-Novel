// Navigation of the mounted paginated view (Book mode page turns, Go to Page, reveal), callable from
// commands and other slices through the pagination index.

/** The mounted view's navigation (set while a PaginatedView is mounted). */
export interface Navigator {
  goToPage: (index: number) => boolean
  /** Next / previous spread (view only: the caret stays). False when there is none. */
  turn: (dir: 1 | -1) => boolean
  /** First / last spread (view only). */
  edge: (dir: 1 | -1) => boolean
  reveal: (pos: number) => boolean
}

let nav: Navigator | null = null

/** The mounted PaginatedView registers its navigation (null on unmount). */
export function setNavigator(n: Navigator | null): void {
  nav = n
}

/**
 * Edit > Go to Page: caret to the start of page `index` (0-based; a blank page goes to the next
 * one), its spread shown (Book mode) or scrolled to the top, focus in the manuscript. False while no
 * pages are laid out.
 */
export function goToPage(index: number): boolean {
  return nav?.goToPage(index) ?? false
}

/**
 * Show the next (dir 1) or previous (-1) spread: in Book mode turn the page, in continuous scroll
 * scroll it to the top. The caret does not move (PageUp / PageDown in the manuscript move it).
 * False at the first / last spread or with nothing laid out.
 */
export function turnSpread(dir: 1 | -1): boolean {
  return nav?.turn(dir) ?? false
}

/** Show the first (dir -1) or last (dir 1) spread. The caret does not move. */
export function goToEdgeSpread(dir: 1 | -1): boolean {
  return nav?.edge(dir) ?? false
}

/**
 * Bring document position `pos` into view, in either navigation mode: Book mode turns to the spread
 * where it is painted, continuous scroll scrolls it to the middle of the window. Finishes a reflow in
 * progress first, so the position is where it is painted. For slices that move the selection to
 * something (Next Comment, Next Change, find): the caret-follow already turns for a selection change,
 * this also covers the cases ProseMirror does not scroll (focus outside the manuscript).
 */
export function revealPosition(pos: number): boolean {
  return nav?.reveal(pos) ?? false
}

/** The page-turn controls' state: is there a spread before / after the one shown? */
export function spreadEdges(index: number, rowCount: number): { atFirst: boolean; atLast: boolean } {
  return { atFirst: index <= 0, atLast: index >= rowCount - 1 }
}

