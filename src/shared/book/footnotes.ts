// Footnote options (footnotes ticket). Pure data + functions; no slice imports.
//
// Storage: `book.footnotes` in book.json (see docs/project-format.md). Only the fields below are
// read; unknown keys are kept on every write. `{}` = the defaults.

import type { FootnoteSettings } from './index'
import { registerBuiltInStyle, STYLE_IDS } from './styles'

export type FootnoteNumbering = 'book' | 'chapter'
export type FootnoteFormat = 'arabic' | 'symbols'

/** Resolved footnote options (every field set). */
export interface FootnoteOptions {
  /** 'book': 1, 2, 3 ... through the whole book; 'chapter': restart at 1 in each chapter. */
  numbering: FootnoteNumbering
  /** 'arabic': 1, 2, 3; 'symbols': *, †, ‡, §, ‖, ¶, then doubled (**, ††, ...). */
  format: FootnoteFormat
  /** A short rule above the footnotes of each page. */
  separator: boolean
}

export const DEFAULT_FOOTNOTE_OPTIONS: Readonly<FootnoteOptions> = Object.freeze({
  numbering: 'book',
  format: 'arabic',
  separator: true,
})

/** The stored settings with defaults filled in (invalid values fall back to the default). */
export function resolveFootnoteOptions(raw: FootnoteSettings | null | undefined): FootnoteOptions {
  const r = raw ?? {}
  return {
    numbering: r.numbering === 'chapter' || r.numbering === 'book' ? r.numbering : DEFAULT_FOOTNOTE_OPTIONS.numbering,
    format: r.format === 'symbols' || r.format === 'arabic' ? r.format : DEFAULT_FOOTNOTE_OPTIONS.format,
    separator: typeof r.separator === 'boolean' ? r.separator : DEFAULT_FOOTNOTE_OPTIONS.separator,
  }
}

/** Writes `patch` into the stored settings (a new object; unknown keys kept). */
export function writeFootnoteOptions(stored: FootnoteSettings, patch: Partial<FootnoteOptions>): FootnoteSettings {
  return { ...stored, ...patch }
}

/** Chicago order of reference marks. */
export const FOOTNOTE_SYMBOLS = ['*', '†', '‡', '§', '‖', '¶'] as const

/** Label of the `n`th footnote (1-based) in `format`. */
export function footnoteLabel(n: number, format: FootnoteFormat): string {
  if (format === 'arabic') return String(n)
  const i = Math.max(0, n - 1)
  return FOOTNOTE_SYMBOLS[i % FOOTNOTE_SYMBOLS.length].repeat(Math.floor(i / FOOTNOTE_SYMBOLS.length) + 1)
}

/** Built-in style of footnote texts at the bottom of the page. */
export const FOOTNOTE_TEXT_STYLE_ID = 'footnote-text'

registerBuiltInStyle(FOOTNOTE_TEXT_STYLE_ID, {
  name: 'Footnote Text',
  kind: 'paragraph',
  basedOn: STYLE_IDS.body,
  fontSize: 9,
  lineHeight: 1.3,
  firstLineIndent: 0,
  spaceBefore: 0,
  spaceAfter: 0,
})
