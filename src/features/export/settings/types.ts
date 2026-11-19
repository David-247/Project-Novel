/**
 * Manuscript export settings (Phase 4). Pure data types: every value is documented in
 * docs/manuscript-format.md (rule, sources, default, alternatives). Lengths are in inches and points
 * so a DOCX or Typst generator can use them as they are (1 in = 72 pt = 25.4 mm).
 */

export type PresetId = 'standard' | 'classic'
export type PaperId = 'letter' | 'a4'

/** Line spacing as a multiple of the font's line height: double (US default) or 1.5 (UK agencies). */
export type LineSpacing = 1 | 1.5 | 2

/** How emphasis is marked: real italics (modern) or underlined text (classic / typewriter). */
export type ItalicsStyle = 'italic' | 'underline'

export type HeaderFormat = 'surname-title-page' | 'title-surname-page' | 'surname-page' | 'page' | 'none'
export type HeaderTitleCase = 'as-typed' | 'upper'

export type EndMarker = 'none' | 'end' | 'the-end'

/** What goes before the author name under the title ("A Novel by Perry Slaughter"). */
export type BylineStyle = 'a-novel-by' | 'by' | 'name-only'

export type WordCountRounding = 'auto' | 'nearest-100' | 'nearest-500' | 'nearest-1000' | 'exact'

export interface Margins {
  top: number
  right: number
  bottom: number
  left: number
}

export interface HeaderSettings {
  format: HeaderFormat
  titleCase: HeaderTitleCase
  /**
   * Physical page the header starts on, counting the title page as page 1.
   * - 2 (default, Shunn): every page but the title page; the first text page is numbered 1.
   * - 1: the title page carries the header too and is numbered 1; the text continues from 2.
   * Without a title page the header runs from the first page, numbered 1. (DOCX and PDF alike.)
   */
  startPage: 1 | 2
  /** The keyword(s) from the title; '' = derive from the manuscript title. */
  shortTitle: string
}

export interface TitlePageSettings {
  /** A separate title page (novels: yes). */
  include: boolean
  /** The contact block (legal name, address, phone, email) in the upper left. */
  showContact: boolean
  /** The agent line in the contact block (only when an agent is known). */
  showAgent: boolean
  /** The approximate word count in the upper right. */
  showWordCount: boolean
  bylineStyle: BylineStyle
}

export interface OutputSettings {
  docx: boolean
  pdf: boolean
}

/**
 * The export wizard's check choices (docs/manuscript-format.md, "Word counts by genre"). Export only:
 * none of them ever changes the manuscript.
 */
export interface CheckSettings {
  /** A `GENRE_WORD_COUNTS` id for the length check; '' = no genre chosen (no length check). */
  genre: string
  /** Compare with the genre's debut range where the sources give one. */
  debut: boolean
  /** Export two or more spaces after a full stop (., !, ?) as one. The manuscript keeps its spaces. */
  normalizeSpaces: boolean
  /**
   * Empty paragraphs between prose paragraphs: `'auto'` reads them as scene breaks (unless they space every
   * paragraph), `'off'` leaves them out (`BuildManuscriptOptions.blankLineSceneBreaks`).
   */
  blankLineSceneBreaks: 'auto' | 'off'
}

export interface ManuscriptSettings {
  preset: PresetId
  paper: PaperId
  /** Font family name as a word processor knows it; see FONT_FALLBACKS for the bundled stand-ins. */
  fontFamily: string
  fontSizePt: number
  lineSpacing: LineSpacing
  margins: Margins
  /** First-line indent of a paragraph, inches. */
  firstLineIndentIn: number
  /** The first paragraph of the text, and of a scene or chapter, is indented too (Shunn). */
  indentFirstParagraph: boolean
  italics: ItalicsStyle
  /** Spaces after a sentence: 1 (modern) or 2 (classic). */
  sentenceSpacing: 1 | 2
  header: HeaderSettings
  /** Centred on a line by itself between scenes. */
  sceneBreak: string
  /** Fraction of the page height a chapter title is dropped (0 = top of the text area). */
  chapterDropFraction: number
  endMarker: EndMarker
  titlePage: TitlePageSettings
  wordCountRounding: WordCountRounding
  outputs: OutputSettings
  checks: CheckSettings
  // The folder of the last export is NOT a project setting (an absolute path, often with the OS user
  // name, must not enter a shareable folder): see getLastOutputFolder() / setLastOutputFolder(), kept in
  // the app's preferences.json by project id.
}

/** Contact details of the author (legal name, pen name, address, phone, email, agent). */
export interface ContactDetails {
  legalName: string
  /** The name on the by-line. '' = the legal name is used. */
  penName: string
  /** Postal address; line breaks are kept. */
  address: string
  phone: string
  email: string
  /** Agent or agency; line breaks are kept. */
  agent: string
}

export const CONTACT_FIELDS = ['legalName', 'penName', 'address', 'phone', 'email', 'agent'] as const satisfies readonly (keyof ContactDetails)[]

/** Longest value of a contact field kept (the app profile and a project override). */
export const CONTACT_MAX: Record<keyof ContactDetails, number> = {
  legalName: 120,
  penName: 120,
  address: 400,
  phone: 60,
  email: 200,
  agent: 300,
}

/** The per-project override of the app profile: only the fields the user set for this project. */
export type ContactOverride = Partial<ContactDetails>
