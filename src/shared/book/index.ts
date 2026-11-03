// Shared book-level types (Phase 2 contract). Pure types/data only; no slice imports.
// The trim size catalog and page geometry helpers (trim-sizes.ts) are added by the
// "Book settings" ticket and re-exported from here.

/** Catalog id of a physical trim size, e.g. 'us-5.5x8.5'. The catalog defines the valid ids. */
export type TrimSizeId = string

/** Page margins in points (1/72 in). Inside = binding/gutter side; outside = fore-edge. */
export interface Margins {
  top: number
  bottom: number
  inside: number
  outside: number
}

/** Style definitions keyed by style id. Shape owned by the styles ticket. */
export type StyleSheetJSON = Record<string, Record<string, unknown>>
/** Running head / page number settings. Shape owned by the headers/footers ticket. */
export type HeaderFooterSettings = Record<string, unknown>
/** Footnote numbering settings. Shape owned by the footnotes ticket. */
export type FootnoteSettings = Record<string, unknown>

export type PaperSurface = 'auto' | 'book' | 'white' | 'dark'
export type BookView = 'spread' | 'single'

/** Everything persisted in book.json. */
export interface BookSettings {
  trimSize: TrimSizeId
  margins: Margins
  styles: StyleSheetJSON
  headerFooter: HeaderFooterSettings
  footnotes: FootnoteSettings
  surface: PaperSurface
  view: BookView
  /**
   * Unknown top-level keys of book.json (written by a newer Novel), kept so a save does not drop them.
   * Added by the Book settings ticket; absent for default settings.
   */
  extra?: Record<string, unknown>
}

export const DEFAULT_TRIM_SIZE: TrimSizeId = 'us-5.5x8.5'

/** Defaults for a 5.5 x 8.5 in trade paperback (points). */
export const DEFAULT_MARGINS: Margins = { top: 54, bottom: 54, inside: 63, outside: 45 }

export * from './trim-sizes'

export function defaultBookSettings(): BookSettings {
  return {
    trimSize: DEFAULT_TRIM_SIZE,
    margins: { ...DEFAULT_MARGINS },
    styles: {},
    headerFooter: {},
    footnotes: {},
    surface: 'auto',
    view: 'spread',
  }
}
