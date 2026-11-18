import type { ExportFontRole } from '../platform'
import type { LineSpacing } from '../settings'

/**
 * Vertical metrics of the manuscript fonts (docs/manuscript-format.md, "Line spacing"), in em.
 * Times New Roman, Tinos and Liberation Serif share them; so do Courier New, Cousine and Liberation Mono.
 *
 * - `single`: Word's single line height, ascent + descent + line gap of the hhea / win metrics
 *   (Times 1825 + 443 + 87 of 2048 units; Courier 1705 + 615 + 0). Word's "Double" is twice it, and
 *   the PDF must match the DOCX, so the PDF line pitch is derived from it too.
 * - `ascender` / `descender`: the hhea ascender and descender. The Typst line box is set to exactly
 *   this height (`top-edge` / `bottom-edge` as lengths, not Typst's "ascender" / "descender" edges,
 *   which read the OS/2 typo metrics: 0.909 em for Liberation Serif, not 1.1074 em), so that
 *   `leading` is the documented gap: 14.31 pt (Times) and 13.60 pt (Courier) at 12 pt double.
 */
export interface FontMetrics {
  single: number
  ascender: number
  descender: number
}

export const FONT_METRICS: Record<ExportFontRole, FontMetrics> = {
  serif: { single: (1825 + 443 + 87) / 2048, ascender: 1825 / 2048, descender: 443 / 2048 },
  mono: { single: (1705 + 615) / 2048, ascender: 1705 / 2048, descender: 615 / 2048 },
}

/** Families set in the mono (Courier) role; everything else is set in the serif (Times) role. */
const MONO = /courier|cousine|liberation mono|\bmono\b/i

/**
 * The bundled font role for a settings font family (trimmed here: settings keep what was typed).
 * The PDF engine knows two roles: Times New Roman (fallback Liberation Serif) and Courier New
 * (fallback Liberation Mono).
 */
export function fontRoleOf(fontFamily: string): ExportFontRole {
  return MONO.test(fontFamily.trim()) ? 'mono' : 'serif'
}

export interface LineMetrics {
  /** Baseline-to-baseline distance of the body text, pt. */
  pitch: number
  /** The line box (ascender + descender), pt. */
  box: number
  /** `par.leading` (and `par.spacing`): the gap between two line boxes, pt. */
  leading: number
  /** Leading of single-spaced text (title-page contact block, footnotes), pt. */
  singleLeading: number
  /** `text.top-edge` / `text.bottom-edge`, em (bottom is negative: below the baseline). */
  topEdgeEm: number
  bottomEdgeEm: number
}

const round = (n: number) => Math.round(n * 1000) / 1000

/** The line metrics of `role` at `sizePt` with `spacing` (1, 1.5 or 2 times single). */
export function lineMetrics(role: ExportFontRole, sizePt: number, spacing: LineSpacing): LineMetrics {
  const m = FONT_METRICS[role]
  const single = m.single * sizePt
  const box = (m.ascender + m.descender) * sizePt
  return {
    pitch: round(single * spacing),
    box: round(box),
    leading: round(single * spacing - box),
    singleLeading: round(single - box),
    topEdgeEm: Math.round(m.ascender * 10_000) / 10_000,
    bottomEdgeEm: -Math.round(m.descender * 10_000) / 10_000,
  }
}
