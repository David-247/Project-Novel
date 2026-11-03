import {
  DEFAULT_MARGINS,
  defaultBookSettings,
  isTrimSizeId,
  type BookSettings,
  type BookView,
  type Margins,
  type PaperSurface,
} from '@/shared/book'
import { useStore } from '@/shared/store'

/** book.json: book-level layout settings (docs/project-format.md, "book.json"). */
export const BOOK_FILE = 'book.json'
export const BOOK_FORMAT = 'novel-book'
export const BOOK_VERSION = 1

const SURFACES: readonly PaperSurface[] = ['auto', 'book', 'white', 'dark']
const VIEWS: readonly BookView[] = ['spread', 'single']
/** Margins above this (points, 100 in) are treated as damaged values. */
const MAX_MARGIN_PT = 7200
/** Keys this version owns; every other top-level key is kept in `extra`. */
const KNOWN_KEYS = new Set(['format', 'version', 'trimSize', 'margins', 'styles', 'headerFooter', 'footnotes', 'surface', 'view'])

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export interface BookParseResult {
  settings: BookSettings
  /** Plain-language notes about values that were replaced by defaults (empty when all was fine). */
  warnings: string[]
}

function normalizeMargins(v: unknown, warnings: string[]): Margins {
  const out: Margins = { ...DEFAULT_MARGINS }
  if (v === undefined) return out
  if (!isObject(v)) {
    warnings.push('the margins')
    return out
  }
  let bad = false
  for (const key of ['top', 'bottom', 'inside', 'outside'] as const) {
    const m = v[key]
    if (m === undefined) continue
    if (typeof m === 'number' && Number.isFinite(m) && m >= 0 && m <= MAX_MARGIN_PT) out[key] = m
    else bad = true
  }
  if (bad) warnings.push('the margins')
  return out
}

function normalizeRecord(v: unknown, name: string, warnings: string[]): Record<string, never> | Record<string, unknown> {
  if (v === undefined) return {}
  if (isObject(v)) return v
  warnings.push(name)
  return {}
}

/** Validate already-parsed book settings (book.json or a recovery snapshot). Never throws. */
export function normalizeBook(data: unknown): BookParseResult {
  const defaults = defaultBookSettings()
  if (!isObject(data)) return { settings: defaults, warnings: ['the whole file'] }
  const warnings: string[] = []
  const settings = defaults

  if (data.trimSize !== undefined) {
    if (isTrimSizeId(data.trimSize)) settings.trimSize = data.trimSize
    else warnings.push('the trim size')
  }
  settings.margins = normalizeMargins(data.margins, warnings)
  settings.styles = normalizeRecord(data.styles, 'the styles', warnings) as BookSettings['styles']
  settings.headerFooter = normalizeRecord(data.headerFooter, 'the headers and footers', warnings)
  settings.footnotes = normalizeRecord(data.footnotes, 'the footnote settings', warnings)
  if (data.surface !== undefined) {
    if (SURFACES.includes(data.surface as PaperSurface)) settings.surface = data.surface as PaperSurface
    else warnings.push('the paper surface')
  }
  if (data.view !== undefined) {
    if (VIEWS.includes(data.view as BookView)) settings.view = data.view as BookView
    else warnings.push('the page view')
  }
  const extra: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(data)) if (!KNOWN_KEYS.has(k)) extra[k] = v
  if (Object.keys(extra).length > 0) settings.extra = extra
  return { settings, warnings }
}

/** Parse book.json text. Damaged JSON gives default settings plus a warning; never throws. */
export function parseBook(text: string): BookParseResult {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return { settings: defaultBookSettings(), warnings: ['the whole file'] }
  }
  return normalizeBook(data)
}

/** One status-bar sentence for the parts of book.json that were replaced by defaults. */
export function bookWarningText(warnings: string[]): string {
  const what = warnings.length === 1 && warnings[0] === 'the whole file' ? `${BOOK_FILE} is damaged` : `${BOOK_FILE} had invalid values (${warnings.join(', ')})`
  return `${what}, so default book settings are in use. Your manuscript was not changed; saving will rewrite ${BOOK_FILE}.`
}

/** Pretty-printed book.json text. Unknown keys kept in `extra` are written back after the known ones. */
export function serializeBook(b: BookSettings): string {
  const { extra, ...known } = b
  return (
    JSON.stringify(
      {
        ...Object.fromEntries(Object.entries(extra ?? {}).filter(([k]) => !KNOWN_KEYS.has(k))),
        format: BOOK_FORMAT,
        version: BOOK_VERSION,
        trimSize: known.trimSize,
        margins: known.margins,
        styles: known.styles,
        headerFooter: known.headerFooter,
        footnotes: known.footnotes,
        surface: known.surface,
        view: known.view,
      },
      null,
      2,
    ) + '\n'
  )
}

/** The settings currently in the store, without the store-only bookkeeping fields. */
export function currentBookSettings(): BookSettings {
  const { settingsVersion: _v, dirty: _d, ...settings } = useStore.getState().book
  void _v
  void _d
  return settings
}

/** True when the store's book settings have unsaved changes. */
export const isBookDirty = (): boolean => useStore.getState().book.dirty
export const getBookVersion = (): number => useStore.getState().book.settingsVersion
