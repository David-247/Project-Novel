import { bylineName, contactBlockLines, formatWordCount, headerShortTitle, runningHeader, surnameOf } from '../settings'
import type { BylineStyle, ContactDetails, ManuscriptSettings } from '../settings'

/**
 * What the title page and the running header say, derived from the settings, the contact block and
 * the title (pure). The wizard's previews and the renderers' title-page data use the same values.
 * Text settings are stored untrimmed (a field being typed in keeps its space), so they are trimmed here,
 * where they are used.
 */

export interface TitlePageData {
  title: string
  /** The resolved contact block (each field trimmed). */
  contact: ContactDetails
  /** The name on the by-line: the pen name, else the legal name. */
  name: string
  /** "A Novel by Ann Waight", "by Ann Waight" or "Ann Waight" ('' without a name). */
  byline: string
  /** The header surname (`surnameOf(name)`). */
  surname: string
  /** The header's short title: the setting, else the title. */
  shortTitle: string
  /** The exported text's word count, and the title page's wording of it ("about 80,000 words"). */
  wordCount: number
  wordCountText: string
  /** The genre id of the length check ('' = none). */
  genre: string
}

const trimContact = (c: ContactDetails): ContactDetails => ({
  legalName: c.legalName.trim(),
  penName: c.penName.trim(),
  address: c.address.trim(),
  phone: c.phone.trim(),
  email: c.email.trim(),
  agent: c.agent.trim(),
})

export function bylineText(style: BylineStyle, name: string): string {
  if (!name) return ''
  return style === 'a-novel-by' ? `A Novel by ${name}` : style === 'by' ? `by ${name}` : name
}

export function titlePageData(settings: ManuscriptSettings, contact: ContactDetails, title: string, wordCount: number): TitlePageData {
  const c = trimContact(contact)
  const name = bylineName(c)
  const t = title.trim()
  return {
    title: t,
    contact: c,
    name,
    byline: bylineText(settings.titlePage.bylineStyle, name),
    surname: surnameOf(name),
    shortTitle: headerShortTitle(settings.header, t),
    wordCount,
    wordCountText: formatWordCount(wordCount, settings.wordCountRounding),
    genre: settings.checks.genre,
  }
}

/** The running header of physical page `page` (the title page is 1), or '' where none is printed. */
export function headerText(settings: ManuscriptSettings, data: Pick<TitlePageData, 'surname' | 'shortTitle'>, page: number): string {
  if (settings.titlePage.include && page < settings.header.startPage) return ''
  // The number printed: 1 on the first text page when the title page is not numbered.
  const printed = settings.titlePage.include && settings.header.startPage === 2 ? page - 1 : page
  return runningHeader(settings.header, { surname: data.surname, shortTitle: data.shortTitle, page: printed })
}

/** The contact block's lines, by the generators' own rule (settings `contactBlockLines`). */
export function contactLines(settings: ManuscriptSettings, c: ContactDetails): string[] {
  return contactBlockLines(c, settings.titlePage)
}

/** Characters Windows and macOS refuse in a file name, and control characters. */
// eslint-disable-next-line no-control-regex
const UNSAFE = /[/\\:*?"<>|\u0000-\u001f\u007f]/g

const fileSafe = (s: string) =>
  s
    .replace(UNSAFE, '')
    .trim()
    .replace(/\s+/g, '_')
    .replace(/^\.+|\.+$/g, '')

/**
 * The default export file name: `Surname_TITLE_manuscript.docx` (the short title, in capitals, words
 * joined by `_`). Parts that are missing are left out ("Manuscript.pdf" with neither).
 */
export function manuscriptFileName(data: Pick<TitlePageData, 'surname' | 'shortTitle'>, extension: string): string {
  const parts = [fileSafe(data.surname), fileSafe(data.shortTitle).toUpperCase()].filter(Boolean)
  const base = parts.length ? `${parts.join('_')}_manuscript` : 'Manuscript'
  return `${base.slice(0, 120)}.${extension}`
}

/** The folder of a file path ('/a/b/c.pdf' -> '/a/b', 'C:\\x\\y.docx' -> 'C:\\x'), or null. */
export function folderOf(path: string): string | null {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  if (i <= 0) return null
  const folder = path.slice(0, i)
  // "C:" alone is a drive, not a folder path the dialog can open ("C:\").
  return /^[A-Za-z]:$/.test(folder) ? `${folder}\\` : folder
}

/** The file name part of a path. */
export function fileNameOf(path: string): string {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return path.slice(i + 1)
}
