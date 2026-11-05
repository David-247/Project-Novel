import {
  defaultBookSettings,
  type BookSettings,
  type BookView,
  type FootnoteSettings,
  type HeaderFooterSettings,
  type Margins,
  type PaperSurface,
  type StyleSheetJSON,
  type TrimSizeId,
} from '@/shared/book'
import type { SliceCreator } from './types'

type Updater<T> = T | ((prev: T) => T)
const apply = <T>(u: Updater<T>, prev: T): T => (typeof u === 'function' ? (u as (p: T) => T)(prev) : u)

/**
 * Book-level settings (Phase 2 contract): trim size, margins, styles, running heads,
 * footnote options, paper surface and view. Persisted as book.json by storage.
 *
 * `settingsVersion` increments on every change; `dirty` is true after a user change until
 * storage calls `markBookClean(version)` (same race-safe pattern as editor.markClean).
 */
export interface BookSlice {
  book: BookSettings & { settingsVersion: number; dirty: boolean }
  bookActions: {
    /**
     * Change the trim size; with `margins`, set those in the same update (the trim size picker moves
     * the margins to the new size defaults: one store update, so pagination reflows once).
     */
    setTrimSize: (id: TrimSizeId, margins?: Margins) => void
    setMargins: (margins: Margins) => void
    setStyles: (u: Updater<StyleSheetJSON>) => void
    setHeaderFooter: (u: Updater<HeaderFooterSettings>) => void
    setFootnotes: (u: Updater<FootnoteSettings>) => void
    setSurface: (surface: PaperSurface) => void
    setView: (view: BookView) => void
    /** Turn Track Changes recording on or off for this project (book.json `trackChanges`). */
    setTrackChanges: (on: boolean) => void
    /** Replace all settings (project open / recovery restore). Not a user change: clears dirty. */
    loadBook: (settings: BookSettings) => void
    /** Replace all settings with unsaved ones (crash-recovery restore). Marks the project unsaved. */
    restoreBook: (settings: BookSettings) => void
    /** Back to defaults (project closed). Clears dirty. */
    resetBook: () => void
    /** Settings persisted; clears dirty only if no change happened since `version`. */
    markBookClean: (version?: number) => void
  }
}

export const createBookSlice: SliceCreator<BookSlice> = (set) => {
  const change = (patch: Partial<BookSettings> | ((b: BookSlice['book']) => Partial<BookSettings>)) =>
    set((s) => {
      const p = typeof patch === 'function' ? patch(s.book) : patch
      return { book: { ...s.book, ...p, settingsVersion: s.book.settingsVersion + 1, dirty: true } }
    })
  return {
    book: { ...defaultBookSettings(), settingsVersion: 0, dirty: false },
    bookActions: {
      setTrimSize: (trimSize, margins) => change(margins ? { trimSize, margins } : { trimSize }),
      setMargins: (margins) => change({ margins }),
      setStyles: (u) => change((b) => ({ styles: apply(u, b.styles) })),
      setHeaderFooter: (u) => change((b) => ({ headerFooter: apply(u, b.headerFooter) })),
      setFootnotes: (u) => change((b) => ({ footnotes: apply(u, b.footnotes) })),
      setSurface: (surface) => change({ surface }),
      setView: (view) => change({ view }),
      setTrackChanges: (on) => change({ trackChanges: on }),
      loadBook: (settings) =>
        set((s) => ({ book: { ...settings, settingsVersion: s.book.settingsVersion + 1, dirty: false } })),
      restoreBook: (settings) => change({ ...settings }),
      resetBook: () =>
        set((s) => ({ book: { ...defaultBookSettings(), settingsVersion: s.book.settingsVersion + 1, dirty: false } })),
      markBookClean: (version) =>
        set((s) =>
          s.book.dirty && (version === undefined || version === s.book.settingsVersion)
            ? { book: { ...s.book, dirty: false } }
            : s,
        ),
    },
  }
}
