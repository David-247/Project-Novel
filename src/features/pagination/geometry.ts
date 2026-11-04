import { pageBox, ptToPx, type Margins, type TrimSizeId } from '@/shared/book'

/**
 * Page geometry in CSS px (96 per inch). Everything the layout needs from the book settings, from
 * the book settings catalog (`pageBox`, src/shared/book/trim-sizes.ts). Unknown trim ids fall back
 * to the default size there.
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

/** One book point in CSS px at 100 % zoom (`--nv-pt` on the page surface). */
export const PX_PER_POINT = ptToPx(1)

/** Smallest text block the layout accepts (px), so absurd margins cannot produce zero-size pages. */
export const MIN_TEXT_BLOCK = 48

const round2 = (n: number) => Math.round(n * 100) / 100

/** Page and text-block size in px for a trim id and margins in points. */
export function resolvePageGeometry(trimSize: TrimSizeId, marginsPt: Margins): PageGeometry {
  const box = pageBox(trimSize, marginsPt)
  return {
    pageWidth: round2(box.page.width),
    pageHeight: round2(box.page.height),
    margins: {
      top: round2(ptToPx(marginsPt.top)),
      bottom: round2(ptToPx(marginsPt.bottom)),
      inside: round2(ptToPx(marginsPt.inside)),
      outside: round2(ptToPx(marginsPt.outside)),
    },
    contentWidth: Math.max(MIN_TEXT_BLOCK, round2(box.content.width)),
    contentHeight: Math.max(MIN_TEXT_BLOCK, round2(box.content.height)),
  }
}
