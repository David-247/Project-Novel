/**
 * Placement of a small popover anchored to something in the text (the footnote editor under its
 * reference, the change popover under a tracked change): below the anchor, starting a little left of
 * it, kept inside the window by GUTTER; above the anchor when it does not fit below and does above.
 */
export const ANCHORED_GAP = 8
export const ANCHORED_GUTTER = 8

export interface AnchorRect {
  left: number
  top: number
  bottom: number
}

export function placeAnchored(
  anchor: AnchorRect,
  size: { width: number; height: number },
  viewport: { width: number; height: number } = { width: window.innerWidth, height: window.innerHeight },
  { offsetX = 24, gap = ANCHORED_GAP, gutter = ANCHORED_GUTTER }: { offsetX?: number; gap?: number; gutter?: number } = {},
): { left: number; top: number } {
  const left = Math.round(Math.min(Math.max(gutter, anchor.left - offsetX), Math.max(gutter, viewport.width - size.width - gutter)))
  let top = anchor.bottom + gap
  if (top + size.height > viewport.height - gutter && anchor.top - gap - size.height >= gutter) top = anchor.top - gap - size.height
  return { left, top: Math.round(top) }
}
