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
  /**
   * Author profile (Phase 4): the contact block of an exported manuscript's title page. App-level, like
   * Word's user information, so personal details stay out of project folders unless a project
   * overrides them. '' = not set. Line breaks are kept in `profileAddress` and `profileAgent`.
   */
  profileLegalName: string
  /** The name on the by-line (a pen name); '' = the legal name. */
  profilePenName: string
  profileAddress: string
  profilePhone: string
  profileEmail: string
  profileAgent: string
  /**
   * Folder of the last manuscript export, by project id (a machine-local path, so it lives here and not in
   * the project folder). At most MAX_EXPORT_FOLDERS entries; the oldest are dropped.
   */
  exportFolders: Record<string, string>
  /** View ▸ Navigation Pane (Phase 4, src/features/outline): shown at startup. */
  navigationPane: boolean
  /** The docked navigation pane's width in CSS px (NAV_PANE_MIN_WIDTH to NAV_PANE_MAX_WIDTH). */
  navigationPaneWidth: number
  /** The AI tutor's active connection id (Phase 5); null = none chosen. */
  tutorActiveConnection: string | null
  /** The writer has seen the AI tutor's consumer-plan warning (Sign in with ChatGPT, shown once before the first sign-in). */
  tutorPlanWarningSeen: boolean
  /**
   * Spell check (Phase 5). `enabled`: View ▸ Spelling & Grammar, the editor's underlines (default on).
   * `words`: the user dictionary, words the spell checker accepts in every project.
   */
  spellcheck: { enabled: boolean; words: string[] }
}

export interface Preferences extends PreferenceValues {
  /** Keys of preferences.json this Novel does not know, kept so a write does not drop them. */
  extra: Record<string, unknown>
  /** The file has been read (or found missing / damaged) at startup. */
  loaded: boolean
}

export const MAX_AUTHOR_NAME = 120

/** Longest value of each author-profile field (a project's contact override has the same limits). */
export const PROFILE_MAX = {
  profileLegalName: 120,
  profilePenName: 120,
  profileAddress: 400,
  profilePhone: 60,
  profileEmail: 200,
  profileAgent: 300,
} as const

export const MAX_EXPORT_FOLDERS = 50

/** Limits of a dictionary word and of the user dictionary (also the project's dictionary.json). */
export const MAX_DICTIONARY_WORD_LENGTH = 64
export const MAX_DICTIONARY_WORDS = 5000

/** Navigation pane width limits and default (CSS px). */
export const NAV_PANE_MIN_WIDTH = 200
export const NAV_PANE_MAX_WIDTH = 480
export const NAV_PANE_DEFAULT_WIDTH = 280

/** A width in range, rounded to whole px. */
export function clampNavPaneWidth(px: number): number {
  return Math.round(Math.min(NAV_PANE_MAX_WIDTH, Math.max(NAV_PANE_MIN_WIDTH, px)))
}

/** The default `exportFolders`: one shared object, so a fresh default is `===` the store's (no phantom change). */
const NO_EXPORT_FOLDERS: Record<string, string> = Object.freeze({}) as Record<string, string>

const NO_WORDS: readonly string[] = Object.freeze([])

/**
 * Dictionary words as stored: trimmed strings without whitespace, in range, no case-insensitive
 * duplicates, at most `limit` (one list: the user's or a project's; a merge of both passes Infinity).
 */
export function readDictionaryWords(v: unknown, limit = MAX_DICTIONARY_WORDS): string[] {
  if (!Array.isArray(v)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const w of v) {
    if (typeof w !== 'string') continue
    const word = w.trim()
    if (word === '' || word.length > MAX_DICTIONARY_WORD_LENGTH || /\s/.test(word)) continue
    const key = word.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(word)
    if (out.length >= limit) break
  }
  return out
}

function readSpellcheck(v: unknown): PreferenceValues['spellcheck'] | undefined {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined
  const { enabled, words } = v as { enabled?: unknown; words?: unknown }
  return { enabled: typeof enabled === 'boolean' ? enabled : true, words: readDictionaryWords(words) }
}

function readExportFolders(v: unknown): Record<string, string> | undefined {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined
  const out: Record<string, string> = {}
  for (const [k, p] of Object.entries(v)) {
    if (typeof p === 'string' && p !== '' && k.length <= 64 && p.length <= 1024) out[k] = p
  }
  return Object.fromEntries(Object.entries(out).slice(-MAX_EXPORT_FOLDERS))
}

/** The author-profile keys, in the order of the title-page contact block. */
export const PROFILE_KEYS = ['profileLegalName', 'profilePenName', 'profileAddress', 'profilePhone', 'profileEmail', 'profileAgent'] as const

export function defaultPreferenceValues(authorName = ''): PreferenceValues {
  return {
    authorName,
    authorColor: null,
    pageNavigation: 'book',
    defaultPaper: 'auto',
    defaultTrimSize: DEFAULT_TRIM_SIZE,
    reduceMotion: 'system',
    authorPrompted: false,
    profileLegalName: '',
    profilePenName: '',
    profileAddress: '',
    profilePhone: '',
    profileEmail: '',
    profileAgent: '',
    exportFolders: NO_EXPORT_FOLDERS,
    navigationPane: false,
    navigationPaneWidth: NAV_PANE_DEFAULT_WIDTH,
    tutorActiveConnection: null,
    tutorPlanWarningSeen: false,
    spellcheck: { enabled: true, words: NO_WORDS as string[] },
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
  profileLegalName: (v) => (typeof v === 'string' ? v.slice(0, PROFILE_MAX.profileLegalName) : undefined),
  profilePenName: (v) => (typeof v === 'string' ? v.slice(0, PROFILE_MAX.profilePenName) : undefined),
  profileAddress: (v) => (typeof v === 'string' ? v.slice(0, PROFILE_MAX.profileAddress) : undefined),
  profilePhone: (v) => (typeof v === 'string' ? v.slice(0, PROFILE_MAX.profilePhone) : undefined),
  profileEmail: (v) => (typeof v === 'string' ? v.slice(0, PROFILE_MAX.profileEmail) : undefined),
  profileAgent: (v) => (typeof v === 'string' ? v.slice(0, PROFILE_MAX.profileAgent) : undefined),
  exportFolders: readExportFolders,
  navigationPane: (v) => (typeof v === 'boolean' ? v : undefined),
  navigationPaneWidth: (v) => (typeof v === 'number' && Number.isFinite(v) ? clampNavPaneWidth(v) : undefined),
  tutorActiveConnection: (v) => (v === null ? null : typeof v === 'string' && v !== '' && v.length <= 128 ? v : undefined),
  tutorPlanWarningSeen: (v) => (typeof v === 'boolean' ? v : undefined),
  spellcheck: readSpellcheck,
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
    profileLegalName: p.profileLegalName.trim(),
    profilePenName: p.profilePenName.trim(),
    profileAddress: p.profileAddress.trim(),
    profilePhone: p.profilePhone.trim(),
    profileEmail: p.profileEmail.trim(),
    profileAgent: p.profileAgent.trim(),
    exportFolders: readExportFolders(p.exportFolders) ?? {},
    navigationPane: p.navigationPane,
    navigationPaneWidth: clampNavPaneWidth(p.navigationPaneWidth),
    tutorActiveConnection: p.tutorActiveConnection,
    tutorPlanWarningSeen: p.tutorPlanWarningSeen === true,
    spellcheck: { enabled: p.spellcheck.enabled !== false, words: readDictionaryWords(p.spellcheck.words) },
  }
  return JSON.stringify(out, null, 2) + '\n'
}
