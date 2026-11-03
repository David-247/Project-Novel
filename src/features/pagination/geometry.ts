import type { Margins, TrimSizeId } from '@/shared/book'

/**
 * Page geometry in CSS px (96 per inch). Everything the layout needs from the book settings.
 *
 * TEMPORARY LOCAL ADAPTER: the trim size catalog and `pageBox` belong to the book settings ticket
 * (src/shared/book/trim-sizes.ts), which is not merged yet. `resolvePageGeometry` is the ONE
 * function to swap for it at merge; nothing else in the slice knows trim ids or units.
 */
export interface PageGeometry {
  pageWidth: number
  pageHeight: number
  /** Margins in px. Inside = binding side (right on a verso, left on a recto). */
  margins: Margins
  /** Text block (page minus margins). */
  contentWidth: number
  contentHeight: number
}

export const PX_PER_INCH = 96
export const PX_PER_POINT = 96 / 72
const IN_PER_MM = 1 / 25.4

/** Trim sizes in inches (width x height). Ids follow the book settings catalog. */
const LOCAL_TRIMS: Record<string, readonly [number, number]> = {
  'us-5x8': [5, 8],
  'us-5.25x8': [5.25, 8],
  'us-5.5x8.5': [5.5, 8.5],
  'us-6x9': [6, 9],
  'us-mass-market': [4.25, 6.87],
  a5: [148 * IN_PER_MM, 210 * IN_PER_MM],
  'b-format': [129 * IN_PER_MM, 198 * IN_PER_MM],
  royal: [156 * IN_PER_MM, 234 * IN_PER_MM],
  demy: [138 * IN_PER_MM, 216 * IN_PER_MM],
}

/** Ids the local adapter knows. */
export const LOCAL_TRIM_IDS = Object.keys(LOCAL_TRIMS)

/** Smallest text block the layout accepts (px), so absurd margins cannot produce zero-size pages. */
export const MIN_TEXT_BLOCK = 48

/** Page and text-block size in px for a trim id and margins in points. Unknown ids fall back to 5.5 x 8.5 in. */
export function resolvePageGeometry(trimSize: TrimSizeId, marginsPt: Margins): PageGeometry {
  const [wIn, hIn] = LOCAL_TRIMS[trimSize] ?? LOCAL_TRIMS['us-5.5x8.5']
  const pageWidth = round2(wIn * PX_PER_INCH)
  const pageHeight = round2(hIn * PX_PER_INCH)
  const margins: Margins = {
    top: round2(marginsPt.top * PX_PER_POINT),
    bottom: round2(marginsPt.bottom * PX_PER_POINT),
    inside: round2(marginsPt.inside * PX_PER_POINT),
    outside: round2(marginsPt.outside * PX_PER_POINT),
  }
  return {
    pageWidth,
    pageHeight,
    margins,
    contentWidth: Math.max(MIN_TEXT_BLOCK, round2(pageWidth - margins.inside - margins.outside)),
    contentHeight: Math.max(MIN_TEXT_BLOCK, round2(pageHeight - margins.top - margins.bottom)),
  }
}

function round2(n: number) {
  return Math.round(n * 100) / 100
}
