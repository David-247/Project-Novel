import { fontRoleOf, isKnownFamily } from '../pdf'

/**
 * What the Formatting step says about the font, and what the success screen says about the font the
 * PDF was actually set in. The PDF engine knows two roles only (decision 558311e6, point 3): a family
 * matching Courier / Cousine / Liberation Mono is set in Courier New, any other in Times New Roman;
 * when that font is not installed, in its bundled metric-compatible stand-in (Liberation Mono /
 * Liberation Serif). Other families apply to the Word file only.
 */

const ROLE_FONT = { serif: 'Times New Roman', mono: 'Courier New' } as const
const ROLE_BUNDLED = { serif: 'Liberation Serif', mono: 'Liberation Mono' } as const

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

/**
 * The note under the Font field. `installed`: the installed font families (null or empty while unknown:
 * then the note names both the installed font and its bundled stand-in).
 */
export function formatFontNote(fontFamily: string, installed: readonly string[] | null): string {
  const family = fontFamily.trim()
  const role = fontRoleOf(family)
  const roleFont = ROLE_FONT[role]
  const bundled = ROLE_BUNDLED[role]
  const known = installed !== null && installed.length > 0
  const has = (f: string) => !known || installed.some((i) => same(i, f))
  const roleInstalled = has(roleFont)
  const pdfFont = !known ? `${roleFont} (or ${bundled} where ${roleFont} is not installed)` : roleInstalled ? roleFont : bundled
  const familyMissing = known && !has(family)

  if (same(family, roleFont)) {
    return roleInstalled
      ? 'The font the Word file names and the PDF is set in.'
      : `${roleFont} is not installed on this computer. The PDF uses ${bundled}, a free font with the same letter widths, so the pages break the same; the Word file still names ${roleFont}.`
  }
  if (isKnownFamily(family)) {
    // Tinos, Liberation Serif, Cousine, Liberation Mono: the same letter widths as the role's font.
    return `The PDF is set in ${pdfFont}, which has the same letter widths as ${family}, so the pages break the same. The Word file names ${family}${familyMissing ? ', which is not installed on this computer' : ''}.`
  }
  return `The PDF is set in ${pdfFont}: the PDF can use only Times New Roman or Courier New. ${family} applies to the Word file only${familyMissing ? ', and it is not installed on this computer' : ''}.`
}

/** The font a PDF render reports (pdf/renderer.ts PdfFontReport, as the wizard needs it). */
export interface ExportFontNote {
  /** The family the settings name. */
  requested: string
  /** The family the PDF was set in. */
  family: string
  source: 'system' | 'bundled'
  /** The settings' family is not one the engine sets as such. */
  substituted: boolean
}

/** The success screen's line about the PDF's font, or null when it is the font the settings name. */
export function usedFontNote(font: ExportFontNote | undefined): string | null {
  if (!font) return null
  if (!font.substituted && font.source !== 'bundled' && same(font.requested, font.family)) return null
  if (font.source === 'bundled') {
    const instead = font.substituted ? ` instead of ${font.requested}` : ''
    return `The PDF is set in ${font.family}${instead}, a free font bundled with Novel with the same letter widths as ${font.family === 'Liberation Mono' ? 'Courier New' : 'Times New Roman'}, which is not installed.`
  }
  if (font.substituted) return `The PDF is set in ${font.family}, not ${font.requested}: the PDF can use only Times New Roman or Courier New. The Word file names ${font.requested}.`
  return `The PDF is set in ${font.family}, which has the same letter widths as ${font.requested}.`
}
