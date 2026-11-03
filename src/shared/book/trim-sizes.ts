// Trim size catalog and page geometry helpers. Pure data and functions; no slice imports.
// (Imports from './index' are used lazily only, because index re-exports this module.)
import { DEFAULT_TRIM_SIZE, type Margins, type TrimSizeId } from './index'

/** CSS pixels per inch and points per inch. */
export const PX_PER_INCH = 96
export const PT_PER_INCH = 72
const MM_PER_INCH = 25.4

export const inToPt = (inches: number): number => inches * PT_PER_INCH
export const ptToIn = (pt: number): number => pt / PT_PER_INCH
export const mmToPt = (mm: number): number => (mm / MM_PER_INCH) * PT_PER_INCH
export const ptToMm = (pt: number): number => (pt / PT_PER_INCH) * MM_PER_INCH
export const inToMm = (inches: number): number => inches * MM_PER_INCH
export const mmToIn = (mm: number): number => mm / MM_PER_INCH
export const ptToPx = (pt: number): number => (pt * PX_PER_INCH) / PT_PER_INCH
export const pxToPt = (px: number): number => (px * PT_PER_INCH) / PX_PER_INCH

export type TrimRegion = 'US' | 'UK/EU'

export interface TrimSize {
  id: TrimSizeId
  /** Short name shown in the picker, e.g. "Mass market". */
  label: string
  region: TrimRegion
  /** Page width and height in points. */
  width: number
  height: number
  /** Margins suited to this size, in points. */
  margins: Margins
  /** Human-readable dimensions, e.g. `5.5 x 8.5 in` or `148 x 210 mm`. */
  dimensions: string
}

function us(id: string, label: string, wIn: number, hIn: number, margins: Margins): TrimSize {
  return { id, label, region: 'US', width: inToPt(wIn), height: inToPt(hIn), margins, dimensions: `${wIn} x ${hIn} in` }
}

function eu(id: string, label: string, wMm: number, hMm: number, margins: Margins): TrimSize {
  return { id, label, region: 'UK/EU', width: mmToPt(wMm), height: mmToPt(hMm), margins, dimensions: `${wMm} x ${hMm} mm` }
}

/** The catalog, in picker order. `us-5.5x8.5` is the default (its margins equal DEFAULT_MARGINS). */
export const TRIM_SIZES: readonly TrimSize[] = Object.freeze([
  us('us-5x8', 'Digest', 5, 8, { top: 54, bottom: 54, inside: 58, outside: 40 }),
  us('us-5.25x8', 'Small trade', 5.25, 8, { top: 54, bottom: 54, inside: 60, outside: 42 }),
  us('us-5.5x8.5', 'Trade', 5.5, 8.5, { top: 54, bottom: 54, inside: 63, outside: 45 }),
  us('us-6x9', 'Large trade', 6, 9, { top: 58, bottom: 58, inside: 68, outside: 50 }),
  us('us-mass-market', 'Mass market', 4.25, 6.87, { top: 40, bottom: 40, inside: 46, outside: 32 }),
  eu('uk-a5', 'A5', 148, 210, { top: 56, bottom: 56, inside: 64, outside: 46 }),
  eu('uk-b-format', 'B-format', 129, 198, { top: 50, bottom: 50, inside: 58, outside: 40 }),
  eu('uk-royal', 'Royal', 156, 234, { top: 58, bottom: 58, inside: 68, outside: 50 }),
  eu('uk-demy', 'Demy', 138, 216, { top: 54, bottom: 54, inside: 62, outside: 44 }),
])

export const TRIM_REGIONS: readonly TrimRegion[] = ['US', 'UK/EU']

export function trimSizesByRegion(region: TrimRegion): TrimSize[] {
  return TRIM_SIZES.filter((t) => t.region === region)
}

export function isTrimSizeId(id: unknown): id is TrimSizeId {
  return typeof id === 'string' && TRIM_SIZES.some((t) => t.id === id)
}

/** The catalog entry for `id`, or undefined for an unknown id. */
export function getTrimSize(id: TrimSizeId): TrimSize | undefined {
  return TRIM_SIZES.find((t) => t.id === id)
}

/** The catalog entry for `id`, falling back to the default size for an unknown id. */
export function resolveTrimSize(id: TrimSizeId): TrimSize {
  return getTrimSize(id) ?? (getTrimSize(DEFAULT_TRIM_SIZE) as TrimSize)
}

export interface PageBox {
  /** Full page (trim) size in CSS px. */
  page: { width: number; height: number }
  /** Text area inside the margins in CSS px (never negative). */
  content: { width: number; height: number }
}

/** Page and content-box sizes in CSS px (96 per inch) for a trim size and margins (points). */
export function pageBox(trimSize: TrimSizeId | TrimSize, margins: Margins): PageBox {
  const t = typeof trimSize === 'string' ? resolveTrimSize(trimSize) : trimSize
  const width = ptToPx(t.width)
  const height = ptToPx(t.height)
  return {
    page: { width, height },
    content: {
      width: Math.max(0, width - ptToPx(margins.inside + margins.outside)),
      height: Math.max(0, height - ptToPx(margins.top + margins.bottom)),
    },
  }
}

export function marginsEqual(a: Margins, b: Margins): boolean {
  return a.top === b.top && a.bottom === b.bottom && a.inside === b.inside && a.outside === b.outside
}
