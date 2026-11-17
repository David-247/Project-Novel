import { DEFAULT_TRIM_SIZE, isTrimSizeId, type PaperSurface, type TrimSizeId } from '@/shared/book'

/**
 * App preferences (per user, outside every project): the shape of preferences.json and the pure
 * logic that reads and writes it. No I/O here; src/features/settings does that.
 *
 * The file is versioned JSON. A reader never fails: a missing, damaged or wrongly typed file (or a
 * single wrongly typed value) falls back to the default for what it cannot read, and unknown keys
 * are returned in `extra` so a write puts them back (a newer Novel's keys survive an older one).
 */

/** Bump when the meaning of an existing key changes; add a step to `migrate`. */
export const PREFERENCES_VERSION = 1

export type PageNavigation = 'book' | 'scroll'
export type ReduceMotion = 'system' | 'on' | 'off'

/** The preference values a user can change (everything but bookkeeping). */
export interface PreferenceValues {
  /** Attributes tracked changes and comments. '' = not known yet (asked once, see ensureAuthorName). */
  authorName: string
  /** `#rrggbb` for the author's changes and comments, or null for the automatic colour. */
  authorColor: string | null
  pageNavigation: PageNavigation
  /** Paper surface of new projects. */
  defaultPaper: PaperSurface
  /** Trim size of new projects. */
  defaultTrimSize: TrimSizeId
  reduceMotion: ReduceMotion
  /** The one-time author-name question has been asked (answered or dismissed). */
  authorPrompted: boolean
}

export interface Preferences extends PreferenceValues {
  /** Keys of preferences.json this Novel does not know, kept so a write does not drop them. */
  extra: Record<string, unknown>
  /** The file has been read (or found missing / damaged) at startup. */
  loaded: boolean
}

export const MAX_AUTHOR_NAME = 120

export function defaultPreferenceValues(authorName = ''): PreferenceValues {
  return {
    authorName,
    authorColor: null,
    pageNavigation: 'book',
    defaultPaper: 'auto',
    defaultTrimSize: DEFAULT_TRIM_SIZE,
    reduceMotion: 'system',
    authorPrompted: false,
  }
}

export const PAPER_SURFACES: readonly PaperSurface[] = ['auto', 'book', 'white', 'dark']

/** Per-key readers: return the value if valid, else undefined (the caller uses the default). */
const READERS: { [K in keyof PreferenceValues]: (v: unknown) => PreferenceValues[K] | undefined } = {
  authorName: (v) => (typeof v === 'string' ? v.slice(0, MAX_AUTHOR_NAME) : undefined),
  authorColor: (v) => (v === null ? null : typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : undefined),
  pageNavigation: (v) => (v === 'book' || v === 'scroll' ? v : undefined),
  defaultPaper: (v) => (PAPER_SURFACES.includes(v as PaperSurface) ? (v as PaperSurface) : undefined),
  defaultTrimSize: (v) => (isTrimSizeId(v) ? v : undefined),
  reduceMotion: (v) => (v === 'system' || v === 'on' || v === 'off' ? v : undefined),
  authorPrompted: (v) => (typeof v === 'boolean' ? v : undefined),
}

const KNOWN_KEYS = new Set<string>(Object.keys(READERS))

export interface ParsedPreferences {
  values: PreferenceValues
  extra: Record<string, unknown>
  /** The file's `authorName` was absent or unreadable: the caller supplies the OS default. */
  authorNameMissing: boolean
  /** Why defaults were used for the whole file, if they were. */
  fallback: 'absent' | 'damaged' | null
}

/** Bring an older file's data up to the current version. Version 0 / absent = the v1 keys. */
function migrate(data: Record<string, unknown>, version: number): Record<string, unknown> {
  // v1 is the first version; nothing to move yet. Later versions add steps here, oldest first.
  void version
  return data
}

/** Parse preferences.json. Never throws. */
export function parsePreferences(text: string | null): ParsedPreferences {
  const defaults = defaultPreferenceValues()
  if (text === null || text === undefined) {
    return { values: defaults, extra: {}, authorNameMissing: true, fallback: 'absent' }
  }
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return { values: defaults, extra: {}, authorNameMissing: true, fallback: 'damaged' }
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { values: defaults, extra: {}, authorNameMissing: true, fallback: 'damaged' }
  }
  const raw = data as Record<string, unknown>
  const version = typeof raw.version === 'number' && Number.isFinite(raw.version) ? raw.version : 0
  const body = migrate(raw, version)
  const values: PreferenceValues = { ...defaults }
  const assign = <K extends keyof PreferenceValues>(key: K) => {
    const read = READERS[key](body[key])
    if (read !== undefined) values[key] = read
  }
  ;(Object.keys(READERS) as (keyof PreferenceValues)[]).forEach(assign)
  const extra: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(body)) if (k !== 'version' && !KNOWN_KEYS.has(k)) extra[k] = v
  return { values, extra, authorNameMissing: READERS.authorName(body.authorName) === undefined, fallback: null }
}

/** The text of preferences.json for these preferences (unknown keys first, so ours win a clash). */
export function serializePreferences(p: PreferenceValues & { extra: Record<string, unknown> }): string {
  const out: Record<string, unknown> = {
    ...p.extra,
    version: PREFERENCES_VERSION,
    authorName: p.authorName.trim(),
    authorColor: p.authorColor,
    pageNavigation: p.pageNavigation,
    defaultPaper: p.defaultPaper,
    defaultTrimSize: p.defaultTrimSize,
    reduceMotion: p.reduceMotion,
    authorPrompted: p.authorPrompted,
  }
  return JSON.stringify(out, null, 2) + '\n'
}
