import { bylineName, checkWordCount, formatWordCount, GENRE_WORD_COUNTS } from '../settings'
import type { ContactDetails, ManuscriptSettings } from '../settings'
import type { ManuscriptIR } from '../ir'
import { chapterIssues, chapterLabel, countDoubleSpaces, type ChapterIssue } from './analysis'
import type { DocLocations } from './locate'

/**
 * The export wizard's publisher-standard checks (pure). Each check says, in plain words taken from
 * docs/manuscript-format.md, what an agent or editor expects, what this manuscript does, and offers a
 * way to fix it or see it. Only `blocking` results stop an export: everything else is advice.
 */

export type CheckSeverity = 'pass' | 'info' | 'warning' | 'blocking'

export type CheckId =
  | 'title'
  | 'name'
  | 'contact'
  | 'word-count'
  | 'tracked-changes'
  | 'comments'
  | 'rewrites'
  | 'chapters'
  | 'scene-breaks'
  | 'formatting'
  | 'double-spaces'

/** A wizard field a Fix action goes to (step and control). */
export type WizardField = 'title' | 'legalName' | 'penName' | 'address' | 'phone' | 'email' | 'genre'

export type CheckAction =
  | { kind: 'fix'; field: WizardField }
  | { kind: 'review-changes' }
  | { kind: 'show-comments' }
  | { kind: 'open-rewrite' }
  /** Show me a chapter (-1: the front matter), for a chapter issue or a manual scene break in it. */
  | { kind: 'show-chapter'; chapter: number; label: string; issue: ChapterIssue['kind'] | 'scene-break' }
  /** Show me a place in the manuscript (document positions; `to`: select up to it). */
  | { kind: 'show-position'; pos: number; to?: number; label: string }
  /** Fix by an export-only option (the manuscript is not changed). */
  | { kind: 'option'; option: 'normalizeSpaces' | 'blankLinesOff' }

export interface CheckResult {
  id: CheckId
  severity: CheckSeverity
  /** One line: what was found ("3 tracked changes are still pending"). */
  summary: string
  /** Why it matters and what export does about it (docs/manuscript-format.md, the review defaults). */
  explanation: string
  actions: CheckAction[]
}

export interface CheckInput {
  ir: ManuscriptIR
  settings: ManuscriptSettings
  /** The manuscript title (trimmed by the caller or not: it is trimmed here). */
  title: string
  /** The resolved contact block (author profile + project override). */
  contact: ContactDetails
  /** The word count of the exported text (`manuscriptWordCount(ir).total`). */
  wordCount: number
  /** Where the double space and the stripped formatting are in the manuscript (`locateInDoc`); none: no Show me. */
  locations?: DocLocations
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`

const SEVERITY_ORDER: Record<CheckSeverity, number> = { blocking: 0, warning: 1, info: 2, pass: 3 }

function titleCheck({ title }: CheckInput): CheckResult {
  const ok = title.trim() !== ''
  return {
    id: 'title',
    severity: ok ? 'pass' : 'blocking',
    summary: ok ? `Title: ${title.trim()}` : 'The manuscript has no title.',
    explanation:
      'The title is centred on the title page, a third of the way down, and a short form of it runs in the header of every page, so an editor can put a loose page back in its manuscript.',
    actions: ok ? [] : [{ kind: 'fix', field: 'title' }],
  }
}

function nameCheck({ contact }: CheckInput): CheckResult {
  const name = bylineName(contact)
  return {
    id: 'name',
    severity: name ? 'pass' : 'blocking',
    summary: name ? `By-line: ${name}` : 'There is no author name for the by-line and the header.',
    explanation:
      'The by-line under the title names the author who gets the credit (your pen name, if you use one), and the surname runs in the header ("Surname / Title / page"). Without a name neither can be printed.',
    actions: name ? [] : [{ kind: 'fix', field: contact.penName.trim() ? 'legalName' : 'penName' }],
  }
}

function contactCheck({ settings, contact }: CheckInput): CheckResult {
  const explanation =
    'The contact block in the upper-left corner of the title page gives your legal name, then your address, phone and email, so an agent can reach you and draw up a contract. You may leave out what you prefer not to share, but give at least one way to reach you.'
  if (!settings.titlePage.include || !settings.titlePage.showContact) {
    return { id: 'contact', severity: 'pass', summary: 'The title page has no contact block (turned off).', explanation, actions: [] }
  }
  const missing: WizardField[] = []
  if (!contact.legalName.trim()) missing.push('legalName')
  const reachable = [contact.address, contact.phone, contact.email].some((v) => v.trim() !== '')
  if (!reachable) missing.push('email')
  if (missing.length === 0) return { id: 'contact', severity: 'pass', summary: 'Contact details are complete.', explanation, actions: [] }
  const what =
    missing.length === 2
      ? 'Your legal name and a way to reach you (address, phone or email) are missing.'
      : missing[0] === 'legalName'
        ? 'Your legal name is missing from the contact block.'
        : 'The contact block has no address, phone or email.'
  return { id: 'contact', severity: 'blocking', summary: what, explanation, actions: missing.map((field) => ({ kind: 'fix', field })) }
}

function wordCountCheck({ settings, wordCount }: CheckInput): CheckResult {
  const { genre: genreId, debut } = settings.checks
  const counted = formatWordCount(wordCount, 'exact')
  const base = 'Agents compare a novel’s length with what its genre usually runs to. These ranges are agents’ rules of thumb, not rules: an unusual length is not a rejection, but it may lower the odds, especially for a debut.'
  if (!genreId) {
    return {
      id: 'word-count',
      severity: 'info',
      summary: `${counted}. Choose a genre to compare the length with its usual range.`,
      explanation: base,
      actions: [{ kind: 'fix', field: 'genre' }],
    }
  }
  const r = checkWordCount(genreId, wordCount, { debut })
  if (!r.genre || !r.range) {
    return { id: 'word-count', severity: 'info', summary: `${counted}. Novel has no usual range for this genre.`, explanation: base, actions: [{ kind: 'fix', field: 'genre' }] }
  }
  const range = `${r.range.min.toLocaleString('en-US')} to ${r.range.max.toLocaleString('en-US')} words`
  const label = `${r.genre.label}${debut && r.genre.debut ? ' (debut)' : ''}`
  const summary =
    r.status === 'within'
      ? `${counted}: within the usual ${range} for ${label}.`
      : r.status === 'short'
        ? `${counted}: shorter than the usual ${range} for ${label}.`
        : r.status === 'long'
          ? `${counted}: longer than the usual ${range} for ${label}.`
          : `${counted}: much longer than the usual ${range} for ${label}.`
  return { id: 'word-count', severity: r.status === 'within' ? 'pass' : 'warning', summary, explanation: base, actions: r.status === 'within' ? [] : [{ kind: 'fix', field: 'genre' }] }
}

function trackedCheck({ ir }: CheckInput): CheckResult {
  const n = ir.report.trackedChanges.total
  return {
    id: 'tracked-changes',
    severity: n ? 'warning' : 'pass',
    summary: n ? `${plural(n, 'tracked change')} ${n === 1 ? 'is' : 'are'} still pending.` : 'No tracked changes are pending.',
    explanation:
      'An agent receives a clean manuscript. Pending changes are exported as if you had accepted them all (the text No Markup shows), with no revision marks. Review them first if any should be rejected.',
    actions: n ? [{ kind: 'review-changes' }] : [],
  }
}

function commentsCheck({ ir }: CheckInput): CheckResult {
  const n = ir.report.comments
  return {
    id: 'comments',
    severity: n ? 'info' : 'pass',
    summary: n ? `${plural(n, 'comment')} will not be exported.` : 'There are no comments.',
    explanation: 'Comments are your notes on the manuscript. They are never exported, so nothing you wrote in them reaches an agent.',
    actions: n ? [{ kind: 'show-comments' }] : [],
  }
}

function rewritesCheck({ ir }: CheckInput): CheckResult {
  const n = ir.report.openRewrites
  return {
    id: 'rewrites',
    severity: n ? 'warning' : 'pass',
    summary: n ? `${plural(n, 'passage is', 'passages are')} being re-written.` : 'No re-writes are open.',
    explanation:
      'A passage you are re-writing is exported as it stands in the manuscript; the versions you are trying are not. Keep the version you want first if it should be the one exported.',
    actions: n ? [{ kind: 'open-rewrite' }] : [],
  }
}

const ISSUE_TEXT: Record<ChapterIssue['kind'], (i: ChapterIssue) => string> = {
  empty: (i) => `${i.label} has no text.`,
  untitled: (i) => `${i.label} has no title or number.`,
  gap: (i) => `${i.label}: chapter ${i.expected} was expected, it is numbered ${i.found}.`,
  repeat: (i) => `${i.label} repeats chapter number ${i.found}.`,
}

/** The line a chapter issue's Show me action stands for. */
export const chapterIssueText = (i: ChapterIssue): string => ISSUE_TEXT[i.kind](i)

function chaptersCheck({ ir }: CheckInput): CheckResult {
  const issues = chapterIssues(ir)
  const explanation =
    'Each chapter starts on a new page with its number and title a third of the way down. An empty or untitled chapter, or a chapter number that is skipped or repeated, usually means a heading went missing or a chapter was moved.'
  if (!ir.chapters.length) {
    return { id: 'chapters', severity: 'info', summary: 'The manuscript has no chapter headings (style a heading Chapter Title to start a chapter).', explanation, actions: [] }
  }
  return {
    id: 'chapters',
    severity: issues.length ? 'warning' : 'pass',
    summary: issues.length ? `${plural(issues.length, 'chapter problem')} found.` : `${plural(ir.chapters.length, 'chapter')}, numbered in order.`,
    explanation,
    actions: issues.map((i) => ({ kind: 'show-chapter', chapter: i.chapter, label: chapterIssueText(i), issue: i.kind })),
  }
}

function sceneBreakCheck({ ir, settings }: CheckInput): CheckResult {
  const manual = ir.report.manualSceneBreaks
  const marker = settings.sceneBreak.trim() || '#'
  const blank = manual.filter((m) => m.kind === 'blank').length
  const explanation = `A scene break is "${marker}" centred on a line of its own. A blank line alone is not enough: at the foot of a page it vanishes. Lines such as "* * *" and blank lines between paragraphs are exported as the marker.`
  if (!manual.length) {
    const spacing = ir.report.blankLineSpacing
    return {
      id: 'scene-breaks',
      severity: spacing ? 'info' : 'pass',
      summary: spacing
        ? 'Blank lines separate most paragraphs, so they were read as spacing and left out. To be sure none becomes a scene break, never read blank lines as breaks.'
        : 'No typed scene breaks needed changing.',
      explanation,
      actions: spacing && settings.checks.blankLineSceneBreaks !== 'off' ? [{ kind: 'option', option: 'blankLinesOff' }] : [],
    }
  }
  const parts = [manual.length - blank ? plural(manual.length - blank, 'typed break') : '', blank ? plural(blank, 'blank line') : ''].filter(Boolean)
  const where = (chapter: number) => (chapter < 0 ? 'the front matter' : chapterLabel(ir.chapters[chapter] ?? { index: chapter, numberText: '', titleText: '' }))
  const actions: CheckAction[] = manual.map((m) => ({
    kind: 'show-chapter',
    chapter: m.chapter,
    issue: 'scene-break',
    label: m.kind === 'blank' ? `A blank line in ${where(m.chapter)}` : `"${m.original}" in ${where(m.chapter)}`,
  }))
  return { id: 'scene-breaks', severity: 'info', summary: `${parts.join(' and ')} will be exported as "${marker}".`, explanation, actions }
}

function formattingCheck({ ir, settings, locations }: CheckInput): CheckResult {
  const s = ir.report.strippedFormatting
  const parts = [s.fontFamily ? plural(s.fontFamily, 'font change') : '', s.fontSize ? plural(s.fontSize, 'size change') : '', s.blockLayout ? plural(s.blockLayout, 'paragraph layout') : ''].filter(Boolean)
  const font = `${settings.fontFamily.trim() || 'Times New Roman'} ${settings.fontSizePt} pt`
  return {
    id: 'formatting',
    severity: parts.length ? 'info' : 'pass',
    summary: parts.length ? `Book formatting is left out: ${parts.join(', ')}.` : 'No book formatting needs to be left out.',
    explanation: `A manuscript is not typeset: every page is ${font}, black, double-spaced with an indented first line. Fonts, sizes, colours and spacing you gave the book are left out of the export; italics and bold are kept. The book itself does not change.`,
    actions: parts.length && locations?.formatting != null ? [{ kind: 'show-position', pos: locations.formatting, label: 'the first book formatting left out' }] : [],
  }
}

function spacesCheck({ ir, settings, locations }: CheckInput): CheckResult {
  const n = countDoubleSpaces(ir)
  const fixed = settings.checks.normalizeSpaces
  const explanation =
    'Manuscripts today use one space after a full stop (the Classic, typewriter style used two). Novel can export them as one space; the manuscript keeps the spaces you typed.'
  if (!n) return { id: 'double-spaces', severity: 'pass', summary: 'No double spaces after full stops.', explanation, actions: [] }
  const at = locations?.doubleSpace ?? null
  const found = `${plural(n, 'place')} ${n === 1 ? 'has' : 'have'} two spaces after a full stop${fixed ? ': exported as one space' : ''}.`
  // Show me the first one; a gap that crosses a change of formatting cannot be pointed to, then the
  // export-only option is the fix.
  const actions: CheckAction[] = at
    ? [{ kind: 'show-position', pos: at.from, to: at.to, label: 'the first two spaces after a full stop' }]
    : fixed
      ? []
      : [{ kind: 'option', option: 'normalizeSpaces' }]
  return {
    id: 'double-spaces',
    severity: 'info',
    summary: at || fixed ? found : `${found} Novel cannot point to it in the text (it crosses a change of formatting); export one space instead.`,
    explanation,
    actions,
  }
}

const CHECKS = [titleCheck, nameCheck, contactCheck, wordCountCheck, trackedCheck, commentsCheck, rewritesCheck, chaptersCheck, sceneBreakCheck, formattingCheck, spacesCheck]

/** Every check, in the wizard's order (the order above: title page, then the text). */
export function runChecks(input: CheckInput): CheckResult[] {
  return CHECKS.map((check) => check(input))
}

/** The checks sorted for display: blocking first, then warnings, info and passes (stable). */
export function sortChecks(results: readonly CheckResult[]): CheckResult[] {
  return [...results].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
}

export const hasBlocking = (results: readonly CheckResult[]): boolean => results.some((r) => r.severity === 'blocking')

/** The genre choices for the length check (id '' = no genre). */
export const GENRE_OPTIONS: readonly { value: string; label: string }[] = [
  { value: '', label: 'No genre (skip the length check)' },
  ...GENRE_WORD_COUNTS.map((g) => ({ value: g.id, label: `${g.label} (${g.typical.min / 1000}k to ${g.typical.max / 1000}k)` })),
]
