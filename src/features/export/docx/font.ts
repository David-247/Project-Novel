// presets.ts imports only types: safe in the export worker.
import { FONT_FALLBACKS } from '../settings/presets'
import type { ManuscriptSettings } from '../settings/types'

/** Families the manuscript format knows: every face of FONT_FALLBACKS and its stand-ins, compared without case. */
const KNOWN = new Set(Object.values(FONT_FALLBACKS).flatMap((families) => families.map((f) => f.toLowerCase())))

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
