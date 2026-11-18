import type { ItalicsStyle, ManuscriptSettings, PaperId, PresetId } from './types'

/** The parts of the settings a preset decides: the look of the type. Everything else is the writer's. */
export interface Preset {
  id: PresetId
  label: string
  description: string
  fontFamily: string
  fontSizePt: number
  italics: ItalicsStyle
  sentenceSpacing: 1 | 2
}

/** Shunn "Modern": a proportional serif, italics, one space after a sentence. The default. */
export const STANDARD_PRESET: Preset = {
  id: 'standard',
  label: 'Standard (modern)',
  description: 'Times New Roman 12 pt, italics for emphasis, one space after a sentence. What most agents and editors expect today.',
  fontFamily: 'Times New Roman',
  fontSizePt: 12,
  italics: 'italic',
  sentenceSpacing: 1,
}

/** Shunn "Classic": typewriter look, underline for italics, two spaces after a sentence. */
export const CLASSIC_PRESET: Preset = {
  id: 'classic',
  label: 'Classic (Courier)',
  description: 'Courier New 12 pt, underlined text for italics, two spaces after a sentence. For publications that ask for "Shunn Classic".',
  fontFamily: 'Courier New',
  fontSizePt: 12,
  italics: 'underline',
  sentenceSpacing: 2,
}

export const PRESETS: Record<PresetId, Preset> = { standard: STANDARD_PRESET, classic: CLASSIC_PRESET }

/**
 * Metric-compatible, freely licensed stand-ins (SIL OFL / Apache 2.0) for the fonts a manuscript names,
 * in order of preference: the generator (Typst) uses the first one that is installed or bundled.
 * Tinos / Cousine are the Chrome OS core fonts, metric-compatible with Times New Roman / Courier New.
 */
export const FONT_FALLBACKS: Record<string, readonly string[]> = {
  'Times New Roman': ['Times New Roman', 'Tinos', 'Liberation Serif'],
  'Courier New': ['Courier New', 'Cousine', 'Liberation Mono'],
}

/** The settings with a preset's look applied; paper, margins, title page, outputs ... stay as they are. */
export function applyPreset(settings: ManuscriptSettings, id: PresetId): ManuscriptSettings {
  const p = PRESETS[id]
  return {
    ...settings,
    preset: id,
    fontFamily: p.fontFamily,
    fontSizePt: p.fontSizePt,
    italics: p.italics,
    sentenceSpacing: p.sentenceSpacing,
  }
}

/** Countries that use US Letter (ISO 3166 region codes); the rest of the world uses A4. */
const LETTER_REGIONS = new Set(['US', 'CA', 'MX', 'CL', 'CO', 'VE', 'PH', 'GT', 'CR', 'DO', 'PR', 'PA', 'SV', 'HN', 'NI', 'BZ', 'BO'])

/**
 * The paper size for an OS / browser locale tag (`en-US`, `en_GB`, `zh-Hans-CN`): Letter for the
 * Americas, A4 elsewhere. A tag without a region (`en`, '') cannot say, and gets Letter (the
 * larger market for this app's users; the choice stays in the wizard).
 */
export function paperFromLocale(locale: string | null | undefined): PaperId {
  const parts = (locale ?? '').split(/[-_]/).slice(1)
  const region = parts.find((p) => /^[A-Za-z]{2}$/.test(p) || /^\d{3}$/.test(p))
  if (!region) return 'letter'
  return LETTER_REGIONS.has(region.toUpperCase()) ? 'letter' : 'a4'
}

/** The OS locale, as the webview reports it ('' when unknown). */
export function systemLocale(): string {
  try {
    return (typeof navigator !== 'undefined' && (navigator.languages?.[0] ?? navigator.language)) || ''
  } catch {
    return ''
  }
}

/** The Standard preset on the paper of `locale`. A new object every time. */
export function defaultManuscriptSettings(locale: string | null | undefined = systemLocale()): ManuscriptSettings {
  const p = STANDARD_PRESET
  return {
    preset: p.id,
    paper: paperFromLocale(locale),
    fontFamily: p.fontFamily,
    fontSizePt: p.fontSizePt,
    lineSpacing: 2,
    margins: { top: 1, right: 1, bottom: 1, left: 1 },
    firstLineIndentIn: 0.5,
    indentFirstParagraph: true,
    italics: p.italics,
    sentenceSpacing: p.sentenceSpacing,
    header: { format: 'surname-title-page', titleCase: 'as-typed', startPage: 2, shortTitle: '' },
    sceneBreak: '#',
    chapterDropFraction: 1 / 3,
    endMarker: 'none',
    titlePage: { include: true, showContact: true, showAgent: false, showWordCount: true, bylineStyle: 'a-novel-by' },
    wordCountRounding: 'auto',
    outputs: { docx: true, pdf: true },
    checks: { genre: '', debut: false, normalizeSpaces: false, blankLineSceneBreaks: 'auto' },
  }
}
