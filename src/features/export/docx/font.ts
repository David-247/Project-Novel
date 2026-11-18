import type { ManuscriptSettings } from '../settings/types'

/** Families the manuscript format knows (docs/manuscript-format.md, FONT_FALLBACKS), compared without case. */
const KNOWN = new Set(['times new roman', 'tinos', 'liberation serif', 'courier new', 'cousine', 'liberation mono'])

export interface DocxFontReport {
  /** The settings' font family, trimmed: the name the .docx is written with. */
  requested: string
  /**
   * True when it is not one of the known manuscript families. Reported like the PDF renderer does,
   * but the meaning differs: the .docx names the family as typed, and Word (not the app) substitutes
   * a font if the reader's machine lacks it.
   */
  substituted: boolean
}

export function docxFontReport(settings: Pick<ManuscriptSettings, 'fontFamily'>): DocxFontReport {
  const requested = settings.fontFamily.trim()
  return { requested, substituted: !KNOWN.has(requested.toLowerCase()) }
}
