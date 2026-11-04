// Running heads and page numbers (Phase 2, headers/footers ticket): the book.headerFooter settings
// shape, its validation, and `resolveHeaderFooter`, the one pure function that decides what a page
// shows. Used by the real pages and by the dialog's mini preview, so they can never disagree.
// Pure: no store, no DOM, no slice imports.

export type RunningHeadKind = 'none' | 'title' | 'author' | 'chapter' | 'custom'
export type PageNumberPosition = 'footer-centre' | 'footer-outside' | 'header-outside' | 'none'
export type PageNumberFormat = 'arabic' | 'lower-roman'
/** Numbering of the pages before the first chapter. */
export type FrontMatterNumbering = 'none' | 'roman'

export interface RunningHeadSetting {
  kind: RunningHeadKind
  /** Used when `kind` is 'custom'. */
  text: string
}

/** book.json `headerFooter` (docs/project-format.md). */
export interface HeaderFooterSettings {
  /** Header of left-hand (even) pages. Default: the author's name. */
  verso: RunningHeadSetting
  /** Header of right-hand (odd) pages. Default: the book title. */
  recto: RunningHeadSetting
  pageNumber: {
    position: PageNumberPosition
    /** Format of the body numbers (front matter follows `frontMatter`). */
    format: PageNumberFormat
    /** Number shown on the first body page (the first chapter's page when it restarts). */
    start: number
  }
  frontMatter: FrontMatterNumbering
  /** True: the first chapter's page gets `start`, counting on from there. False: page 1 gets `start`. */
  restartAtFirstChapter: boolean
  suppressHeaderOnOpening: boolean
  suppressNumberOnOpening: boolean
  /** No header and no number on blank pages. */
  suppressOnBlank: boolean
  /** Unknown keys of a newer Novel, kept so a save does not drop them. */
  extra?: Record<string, unknown>
}

export const MAX_START_NUMBER = 9999

export const RUNNING_HEAD_KINDS: readonly RunningHeadKind[] = ['none', 'title', 'author', 'chapter', 'custom']
export const PAGE_NUMBER_POSITIONS: readonly PageNumberPosition[] = ['footer-centre', 'footer-outside', 'header-outside', 'none']
export const PAGE_NUMBER_FORMATS: readonly PageNumberFormat[] = ['arabic', 'lower-roman']
export const FRONT_MATTER_NUMBERINGS: readonly FrontMatterNumbering[] = ['none', 'roman']

export function defaultHeaderFooter(): HeaderFooterSettings {
  return {
    verso: { kind: 'author', text: '' },
    recto: { kind: 'title', text: '' },
    pageNumber: { position: 'footer-centre', format: 'arabic', start: 1 },
    frontMatter: 'none',
    restartAtFirstChapter: true,
    suppressHeaderOnOpening: true,
    suppressNumberOnOpening: true,
    suppressOnBlank: true,
  }
}

const KNOWN_KEYS = new Set([
  'verso',
  'recto',
  'pageNumber',
  'frontMatter',
  'restartAtFirstChapter',
  'suppressHeaderOnOpening',
  'suppressNumberOnOpening',
  'suppressOnBlank',
])

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === 'string' && (list as readonly string[]).includes(v)

export interface HeaderFooterParseResult {
  settings: HeaderFooterSettings
  /** True when some value was invalid and replaced by its default. */
  repaired: boolean
}

/**
 * Validate a stored `headerFooter` value. A missing field is its default (no complaint); an invalid
 * one is replaced by its default and reported. Never throws; unknown keys go to `extra`.
 */
export function parseHeaderFooter(raw: unknown): HeaderFooterParseResult {
  const s = defaultHeaderFooter()
  if (raw === undefined) return { settings: s, repaired: false }
  if (!isObject(raw)) return { settings: s, repaired: true }
  let repaired = false
  const head = (v: unknown, into: RunningHeadSetting) => {
    if (v === undefined) return
    if (!isObject(v)) {
      repaired = true
      return
    }
    if (v.kind !== undefined) {
      if (oneOf(RUNNING_HEAD_KINDS, v.kind)) into.kind = v.kind
      else repaired = true
    }
    if (v.text !== undefined) {
      if (typeof v.text === 'string') into.text = v.text
      else repaired = true
    }
  }
  head(raw.verso, s.verso)
  head(raw.recto, s.recto)
  const pn = raw.pageNumber
  if (pn !== undefined) {
    if (!isObject(pn)) repaired = true
    else {
      if (pn.position !== undefined) {
        if (oneOf(PAGE_NUMBER_POSITIONS, pn.position)) s.pageNumber.position = pn.position
        else repaired = true
      }
      if (pn.format !== undefined) {
        if (oneOf(PAGE_NUMBER_FORMATS, pn.format)) s.pageNumber.format = pn.format
        else repaired = true
      }
      if (pn.start !== undefined) {
        if (typeof pn.start === 'number' && Number.isInteger(pn.start) && pn.start >= 0 && pn.start <= MAX_START_NUMBER) s.pageNumber.start = pn.start
        else repaired = true
      }
    }
  }
  if (raw.frontMatter !== undefined) {
    if (oneOf(FRONT_MATTER_NUMBERINGS, raw.frontMatter)) s.frontMatter = raw.frontMatter
    else repaired = true
  }
  for (const key of ['restartAtFirstChapter', 'suppressHeaderOnOpening', 'suppressNumberOnOpening', 'suppressOnBlank'] as const) {
    if (raw[key] === undefined) continue
    if (typeof raw[key] === 'boolean') s[key] = raw[key]
    else repaired = true
  }
  const extra: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(raw)) if (!KNOWN_KEYS.has(k)) extra[k] = v
  if (Object.keys(extra).length > 0) s.extra = extra
  return { settings: s, repaired }
}

/** The JSON stored in book.json: every field written, unknown keys alongside. */
export function headerFooterToJSON(h: HeaderFooterSettings): Record<string, unknown> {
  const { extra, ...known } = h
  return {
    ...Object.fromEntries(Object.entries(extra ?? {}).filter(([k]) => !KNOWN_KEYS.has(k))),
    verso: known.verso,
    recto: known.recto,
    pageNumber: known.pageNumber,
    frontMatter: known.frontMatter,
    restartAtFirstChapter: known.restartAtFirstChapter,
    suppressHeaderOnOpening: known.suppressHeaderOnOpening,
    suppressNumberOnOpening: known.suppressNumberOnOpening,
    suppressOnBlank: known.suppressOnBlank,
  }
}

// ---- Resolution ------------------------------------------------------------------------------

/** What `resolveHeaderFooter` needs of a page (the layout slice's `PageInfo`, structurally). */
export interface HFPage {
  index: number
  side: 'verso' | 'recto'
  from: number
  to: number
  isBlank: boolean
  /** 0-based chapter in effect at the top of the page; -1 before the first chapter. */
  chapterIndex: number
}

/** What it needs of a chapter (the editor's `Chapter`, structurally). */
export interface HFChapter {
  index: number
  title: string
  from: number
}

/** Project metadata shown in running heads (project.json). */
export interface HFMeta {
  title: string
  author: string
}

export interface ResolvedHeaderFooter {
  /** Running head text; '' for none. */
  headerText: string
  /** Page number text; '' for none. */
  number: string
  /** Where `number` goes; null when there is no number. */
  numberPosition: Exclude<PageNumberPosition, 'none'> | null
  side: 'verso' | 'recto'
}

/** Lower-case Roman numeral of a positive integer (1 -> i); other values fall back to digits. */
export function toLowerRoman(n: number): string {
  if (!Number.isInteger(n) || n <= 0 || n >= 4000) return String(n)
  const table: Array<[number, string]> = [
    [1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'],
    [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i'],
  ]
  let out = ''
  for (const [v, s] of table) {
    while (n >= v) {
      out += s
      n -= v
    }
  }
  return out
}

/** Index of the page holding the first chapter's start (the first body page); no chapters -> 0. */
export function firstBodyPageIndex(pages: readonly HFPage[], chapters: readonly HFChapter[]): number {
  if (chapters.length === 0) return 0
  const at = chapters[0].from
  for (const p of pages) if (!p.isBlank && p.from <= at && at < p.to) return p.index
  // The chapter starts past the published pages (a stale model): everything is front matter.
  return pages.length
}

/** True when a chapter starts on the page (a page break before it, or in the middle of the page). */
export function isChapterOpening(page: HFPage, chapters: readonly HFChapter[]): boolean {
  if (page.isBlank) return false
  // Chapters are in document order: binary search the first start >= page.from.
  let lo = 0
  let hi = chapters.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (chapters[mid].from < page.from) lo = mid + 1
    else hi = mid
  }
  return lo < chapters.length && chapters[lo].from < page.to
}

/**
 * The chapter in effect at the top of a page, from the chapter list itself (not `page.chapterIndex`,
 * which follows pagination's chapter predicate and may differ). A blank page belongs to the chapter
 * before the one starting at its position.
 */
function chapterAt(page: HFPage, chapters: readonly HFChapter[]): HFChapter | undefined {
  let lo = 0
  let hi = chapters.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (page.isBlank ? chapters[mid].from < page.from : chapters[mid].from <= page.from) lo = mid + 1
    else hi = mid
  }
  return lo > 0 ? chapters[lo - 1] : undefined
}

function headText(setting: RunningHeadSetting, chapterTitle: string, meta: HFMeta): string {
  switch (setting.kind) {
    case 'title':
      return meta.title
    case 'author':
      return meta.author
    case 'chapter':
      return chapterTitle
    case 'custom':
      return setting.text
    default:
      return ''
  }
}

/**
 * What one page shows: its running head and page number.
 * - Verso and recto pages use their own header setting (title, author, chapter title, custom, none).
 * - Blank pages show nothing (`suppressOnBlank`); a page where a chapter opens shows no header
 *   (`suppressHeaderOnOpening`) and optionally no number (`suppressNumberOnOpening`).
 * - Pages before the first chapter are front matter: no running head; numbered in lower-case Roman
 *   from i (`frontMatter: 'roman'`) or not at all. Body numbering is `start` on the first chapter's
 *   page (`restartAtFirstChapter`) or `start` on page 1; blank pages are counted.
 * - A book without chapters is all body.
 * `pages` is the whole layout (needed to find the first body page).
 */
export function resolveHeaderFooter(
  page: HFPage,
  pages: readonly HFPage[],
  chapters: readonly HFChapter[],
  settings: HeaderFooterSettings,
  meta: HFMeta,
): ResolvedHeaderFooter {
  return makeHeaderFooterResolver(pages, chapters, settings, meta)(page)
}

/** `resolveHeaderFooter` bound to a layout, for resolving many pages (the first body page is found once). */
export function makeHeaderFooterResolver(
  pages: readonly HFPage[],
  chapters: readonly HFChapter[],
  settings: HeaderFooterSettings,
  meta: HFMeta,
): (page: HFPage) => ResolvedHeaderFooter {
  const firstBody = firstBodyPageIndex(pages, chapters)
  const pn = settings.pageNumber
  return (page) => {
    const blank = page.isBlank
    const opening = isChapterOpening(page, chapters)
    const front = page.index < firstBody
    let headerText = ''
    if (!(blank && settings.suppressOnBlank) && !(opening && settings.suppressHeaderOnOpening) && !front) {
      const title = chapterAt(page, chapters)?.title ?? ''
      headerText = headText(page.side === 'verso' ? settings.verso : settings.recto, title.trim(), meta).trim()
    }
    let number = ''
    const numberHidden =
      pn.position === 'none' || (blank && settings.suppressOnBlank) || (opening && settings.suppressNumberOnOpening)
    if (!numberHidden) {
      if (front) {
        if (settings.frontMatter === 'roman') number = toLowerRoman(page.index + 1)
      } else {
        const n = pn.start + (settings.restartAtFirstChapter ? page.index - firstBody : page.index)
        // Roman numerals exist for 1 to 3999 only: outside that, no number rather than "0" or "-2".
        if (pn.format === 'lower-roman') number = n >= 1 && n <= 3999 ? toLowerRoman(n) : ''
        else number = String(n)
      }
    }
    return {
      headerText,
      number,
      numberPosition: number && pn.position !== 'none' ? pn.position : null,
      side: page.side,
    }
  }
}
