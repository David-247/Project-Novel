// presets.ts imports only types: safe in the export worker.
import { FONT_FALLBACKS } from '../settings/presets'
import type { LineSpacing, ManuscriptSettings, PaperId } from '../settings/types'

/**
 * Page geometry of the DOCX manuscript, in twips (1/20 pt, 1440 per inch: what WordprocessingML
 * measures in). Every value follows docs/manuscript-format.md.
 */

export const TWIPS_PER_INCH = 1440
export const TWIPS_PER_PT = 20

/** Page sizes in twips (Letter 8.5 x 11 in; A4 210 x 297 mm, as Word writes it). */
export const PAPER_TWIPS: Record<PaperId, { width: number; height: number }> = {
  letter: { width: 12240, height: 15840 },
  a4: { width: 11906, height: 16838 },
}

/** Header distance from the top edge: 0.5 in (Word's default, inside the 1 in margin). */
export const HEADER_DISTANCE_TWIPS = 720

/**
 * Word's `w:line` with `lineRule="auto"`: 240 = single, 360 = 1.5, 480 = double. Word derives the
 * pitch from the font itself (Times New Roman 12 pt double: 27.60 pt).
 */
export function autoLine(spacing: LineSpacing): number {
  return Math.round(240 * spacing)
}

/**
 * Single line height (ascent + descent + line gap) as a fraction of the font size, for the fonts
 * the research doc lists; other fonts get 1.15 (a typical text face). Used only to place the title
 * and the blank double-spaced lines (spacing before / after), never the body's line spacing.
 */
const SINGLE_LINE_EM_BY_FACE: Record<string, number> = {
  'Times New Roman': 1.1499,
  'Courier New': 1.1328,
}

/** Every family of FONT_FALLBACKS (a face and its metric-compatible stand-ins), lower-cased, to its metric. */
const SINGLE_LINE_EM = new Map<string, number>(
  Object.entries(FONT_FALLBACKS).flatMap(([face, families]) => {
    const em = SINGLE_LINE_EM_BY_FACE[face]
    return em === undefined ? [] : families.map((f) => [f.toLowerCase(), em] as const)
  }),
)

/** The metric of a known manuscript family, or undefined (tests assert FONT_FALLBACKS is covered). */
export function knownSingleLineEm(fontFamily: string): number | undefined {
  return SINGLE_LINE_EM.get(fontFamily.trim().toLowerCase())
}

export function singleLineEm(fontFamily: string): number {
  return knownSingleLineEm(fontFamily) ?? 1.15
}

const inches = (n: number, min: number, max: number) => Math.round(Math.min(max, Math.max(min, Number.isFinite(n) ? n : min)) * TWIPS_PER_INCH)

export interface DocxLayout {
  page: { width: number; height: number }
  margins: { top: number; right: number; bottom: number; left: number }
  /** Width and height inside the margins. */
  textWidth: number
  textHeight: number
  /** Half-points (w:sz). */
  fontHalfPoints: number
  /** `w:line` of the body (auto rule). */
  bodyLine: number
  /** One single-spaced line of the body font, twips. */
  singleLine: number
  /** One line at the body's spacing (the pitch), twips: a "blank double-spaced line" at the default. */
  pitch: number
  firstLineIndent: number
  /** Space before a chapter heading: `chapterDropFraction` of the text-area height. */
  chapterDrop: number
  /** Space from the top margin to the title on the title page: one third of the text-area height. */
  titleDrop: number
}

/** Font size clamp (the settings allow 8 to 24 pt). */
const fontPt = (n: number) => Math.min(72, Math.max(6, Number.isFinite(n) ? n : 12))

export function docxLayout(settings: ManuscriptSettings): DocxLayout {
  const page = PAPER_TWIPS[settings.paper] ?? PAPER_TWIPS.letter
  const m = settings.margins
  const margins = { top: inches(m.top, 0, 4), right: inches(m.right, 0, 4), bottom: inches(m.bottom, 0, 4), left: inches(m.left, 0, 4) }
  const textWidth = Math.max(TWIPS_PER_INCH, page.width - margins.left - margins.right)
  const textHeight = Math.max(TWIPS_PER_INCH, page.height - margins.top - margins.bottom)
  const size = fontPt(settings.fontSizePt)
  const spacing: LineSpacing = settings.lineSpacing === 1 || settings.lineSpacing === 1.5 ? settings.lineSpacing : 2
  const singleLine = Math.round(singleLineEm(settings.fontFamily) * size * TWIPS_PER_PT)
  const drop = Math.min(0.5, Math.max(0, Number.isFinite(settings.chapterDropFraction) ? settings.chapterDropFraction : 1 / 3))
  return {
    page,
    margins,
    textWidth,
    textHeight,
    fontHalfPoints: Math.round(size * 2),
    bodyLine: autoLine(spacing),
    singleLine,
    pitch: Math.round(singleLine * spacing),
    firstLineIndent: inches(settings.firstLineIndentIn, 0, 2),
    chapterDrop: Math.round(textHeight * drop),
    titleDrop: Math.round(textHeight / 3),
  }
}
