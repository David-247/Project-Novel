import type { ContactDetails, ContactOverride, HeaderSettings, ManuscriptSettings, WordCountRounding } from './types'
import { CONTACT_FIELDS } from './types'

/** Below this many words the "auto" rule rounds to the nearest hundred, from it to the nearest 500. */
export const AUTO_ROUNDING_THRESHOLD = 20_000

const STEP: Record<Exclude<WordCountRounding, 'auto' | 'exact'>, number> = {
  'nearest-100': 100,
  'nearest-500': 500,
  'nearest-1000': 1000,
}

/** The word count as the title page states it, per the rounding rule (half rounds up). */
export function roundWordCount(count: number, rule: WordCountRounding): number {
  const n = Math.max(0, Number.isFinite(count) ? Math.round(count) : 0)
  if (rule === 'exact') return n
  const step = rule === 'auto' ? (n < AUTO_ROUNDING_THRESHOLD ? 100 : 500) : STEP[rule]
  return Math.round(n / step) * step
}

const thousands = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')

/** "about 80,000 words" (rounded), or "82,260 words" (exact). Independent of the OS locale. */
export function formatWordCount(count: number, rule: WordCountRounding): string {
  const n = roundWordCount(count, rule)
  const unit = n === 1 ? 'word' : 'words'
  return `${rule === 'exact' ? '' : 'about '}${thousands(n)} ${unit}`
}

const SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'phd', 'md'])

/** The surname of a by-line name: its last word, ignoring Jr., III ... ('Madonna' is its own). */
export function surnameOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  while (words.length > 1 && SUFFIXES.has(words[words.length - 1].replace(/[.,]/g, '').toLowerCase())) words.pop()
  return words.length ? words[words.length - 1] : ''
}

/** The scene-break marker as printed: settings persist it untrimmed; blank means the default '#'. */
export function sceneBreakText(settings: Pick<ManuscriptSettings, 'sceneBreak'>): string {
  return settings.sceneBreak.trim() || '#'
}

/** The running header's short title: the trimmed setting, or else the (trimmed) manuscript title. */
export function headerShortTitle(header: Pick<HeaderSettings, 'shortTitle'>, title: string): string {
  return header.shortTitle.trim() || title.trim()
}

/**
 * The manuscript title as both generators print it (title page, running header, document properties):
 * trimmed, "Untitled" when empty. The wizard's missing-title check normally blocks an empty one.
 */
export function manuscriptTitle(title: string): string {
  return title.trim() || 'Untitled'
}

/** A multi-line field's lines: split at CRLF, LF or a lone CR, each trimmed, empty ones left out. */
const fieldLines = (s: string) =>
  s
    .split(/\r\n|\n|\r/)
    .map((l) => l.trim())
    .filter(Boolean)

/**
 * The title page's contact block, in Shunn's order (legal name, address, phone, email, then the
 * agent when shown); every field may hold several lines. The one rule of both generators and the
 * wizard's preview.
 */
export function contactBlockLines(c: ContactDetails, show: Pick<ManuscriptSettings['titlePage'], 'showContact' | 'showAgent'>): string[] {
  if (!show.showContact) return []
  return [c.legalName, c.address, c.phone, c.email, ...(show.showAgent ? [c.agent] : [])].flatMap(fieldLines)
}

export interface HeaderContext {
  surname: string
  shortTitle: string
  /** The page number, or a placeholder string a generator replaces with a page field (DOCX: PAGE). */
  page: number | string
}

/** The running-header text of one page: "Surname / Title / 13". Empty parts are left out. */
export function runningHeader(h: Pick<HeaderSettings, 'format' | 'titleCase'>, ctx: HeaderContext): string {
  const title = h.titleCase === 'upper' ? ctx.shortTitle.toUpperCase() : ctx.shortTitle
  const page = String(ctx.page)
  const parts =
    h.format === 'surname-title-page'
      ? [ctx.surname, title, page]
      : h.format === 'title-surname-page'
        ? [title, ctx.surname, page]
        : h.format === 'surname-page'
          ? [ctx.surname, page]
          : h.format === 'page'
            ? [page]
            : []
  return parts.filter((p) => p !== '').join(' / ')
}

/**
 * The contact block of a manuscript: the app profile, each field replaced by the project's override
 * where the project sets one (an empty override field means "not overridden").
 */
export function resolveContact(profile: ContactDetails, override: ContactOverride): ContactDetails {
  const out = { ...profile }
  for (const k of CONTACT_FIELDS) {
    const v = override[k]
    if (typeof v === 'string' && v.trim() !== '') out[k] = v
  }
  return out
}

/** The name for the by-line and the header surname: the pen name when set, else the legal name. */
export function bylineName(c: ContactDetails): string {
  return c.penName.trim() || c.legalName.trim()
}
