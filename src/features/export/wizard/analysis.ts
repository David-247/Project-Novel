import { manuscriptWordCount, runsText } from '../ir'
import type { InlineRun, ManuscriptBlock, ManuscriptChapter, ManuscriptIR, NoteRun } from '../ir'

/**
 * What the export wizard reads from a manuscript IR (pure; the word count is `manuscriptWordCount` in
 * ../ir): chapter problems (empty, untitled, numbering gaps) and double spaces after a full stop, and the export-only normalisation
 * of those spaces. The IR is never changed; `normalizeSentenceSpaces` returns a new one.
 */

/**
 * The title page's word count, the same for every format (docs/manuscript-format.md: the app's word
 * count): the IR's text words, plus its footnote words exactly when Word Count's "Include footnotes" is
 * on (the rule of the status bar and the Word Count dialog). The wizard passes it to each renderer.
 */
export function titlePageWordCount(ir: ManuscriptIR, includeFootnotes: boolean): number {
  const wc = manuscriptWordCount(ir)
  return includeFootnotes ? wc.total : wc.body
}

// ---- chapter numbers ------------------------------------------------------------------------------

const UNITS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen']
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety']

/** "one" .. "ninety-nine" (also "twenty one"), or null. */
function wordNumber(text: string): number | null {
  const parts = text.toLowerCase().split(/[\s-]+/).filter(Boolean)
  if (parts.length === 1) {
    const u = UNITS.indexOf(parts[0])
    if (u > 0) return u
    const t = TENS.indexOf(parts[0])
    return t >= 2 ? t * 10 : null
  }
  if (parts.length === 2) {
    const t = TENS.indexOf(parts[0])
    const u = UNITS.indexOf(parts[1])
    if (t >= 2 && u >= 1 && u <= 9) return t * 10 + u
  }
  return null
}

const ROMAN: Record<string, number> = { i: 1, v: 5, x: 10, l: 50, c: 100 }

/** A Roman numeral up to C (I, IV, XII, xl), or null. */
function romanNumber(text: string): number | null {
  const s = text.toLowerCase()
  if (!/^[ivxlc]+$/.test(s)) return null
  let total = 0
  for (let i = 0; i < s.length; i++) {
    const v = ROMAN[s[i]]
    const next = ROMAN[s[i + 1]] ?? 0
    total += v < next ? -v : v
  }
  // Only the canonical spelling ("IIII" and "IC" are not chapter numbers).
  return total > 0 && toRoman(total) === s ? total : null
}

function toRoman(n: number): string {
  const table: [number, string][] = [[100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']]
  let out = ''
  for (const [v, r] of table) while (n >= v) {
    out += r
    n -= v
  }
  return out
}

/**
 * The number a chapter heading states: "Chapter 3", "Chapter Three", "CHAPTER XII", "12", "IV.",
 * "Chapter Twenty-One: The Fall". Null when it states none ("Prologue", "The Storm"). A bare word
 * number or Roman numeral counts only when it is the whole heading (so "I Remember" is no number).
 */
export function chapterNumberOf(text: string): number | null {
  const t = text.trim().replace(/[.:]+$/, '')
  if (!t) return null
  const labelled = /^(?:chapter|ch\.?)\s+(.+?)(?:\s*[:.\-–—]\s.*)?$/i.exec(t)
  const candidate = labelled ? labelled[1].trim().replace(/[.:]+$/, '') : t
  if (/^\d{1,4}$/.test(candidate)) return Number(candidate)
  const asWord = wordNumber(candidate)
  if (asWord !== null) return asWord
  return romanNumber(candidate)
}

export type ChapterIssueKind = 'empty' | 'untitled' | 'gap' | 'repeat'

export interface ChapterIssue {
  kind: ChapterIssueKind
  /** IR chapter index (the editor's `getChapters` index in the No Markup view). */
  chapter: number
  /** The heading as the user sees it ("Chapter 3 · The Storm", or "Untitled chapter 3"). */
  label: string
  /** For `gap` / `repeat`: the number expected next and the one found. */
  expected?: number
  found?: number
}

/** The visible name of a chapter: its number and title lines, or "Untitled chapter N" (1-based). */
export function chapterLabel(c: Pick<ManuscriptChapter, 'index' | 'numberText' | 'titleText'>): string {
  const parts = [c.numberText.trim(), c.titleText.trim()].filter(Boolean)
  return parts.length ? parts.join(' · ') : `Untitled chapter ${c.index + 1}`
}

/**
 * Chapters an editor would query: no text (`empty`), no title (`untitled`: an empty title block, and no
 * number either), and numbering that skips or repeats (`gap`, `repeat`), read from the number line or,
 * without one, the title ("Chapter 3"). Unnumbered chapters (a prologue) are skipped by the numbering
 * check; the first numbered chapter may start anywhere.
 */
export function chapterIssues(ir: Pick<ManuscriptIR, 'chapters'>): ChapterIssue[] {
  const issues: ChapterIssue[] = []
  let last: number | null = null
  for (const c of ir.chapters) {
    const label = chapterLabel(c)
    if (!c.titleText.trim() && !c.numberText.trim()) issues.push({ kind: 'untitled', chapter: c.index, label })
    const hasText = c.blocks.some((b) => b.kind === 'paragraph' && runsText(b.runs).trim() !== '')
    if (!hasText) issues.push({ kind: 'empty', chapter: c.index, label })
    const n = chapterNumberOf(c.numberText) ?? (c.numberText.trim() ? null : chapterNumberOf(c.titleText))
    if (n === null) continue
    if (last !== null && n !== last + 1) issues.push({ kind: n === last ? 'repeat' : 'gap', chapter: c.index, label, expected: last + 1, found: n })
    last = n
  }
  return issues
}

// ---- sentence spacing ----------------------------------------------------------------------------

const SENTENCE_END = new Set(['.', '!', '?'])
/** Closing marks that may follow the full stop before the space: quotes, brackets. */
const CLOSERS = new Set(['"', "'", '”', '’', ')', ']', '»'])

/**
 * Walks runs as one text, finding two or more plain spaces (U+0020) after a sentence end (. ! ? and any
 * closing quotes or brackets). `rewrite` returns the runs with each such gap made one space; `count` is
 * the number of gaps. Line breaks, footnote references and other text reset the walk. Spaces across
 * run boundaries (a full stop in an italic run, the spaces in the next) are found too.
 */
function scanRuns<R extends InlineRun | NoteRun>(runs: readonly R[]): { runs: R[]; count: number } {
  // 'end': just after a sentence end (and its closers); 'space': its first space; 'extra': in a gap.
  let state: 'text' | 'end' | 'space' | 'extra' = 'text'
  let count = 0
  let changed = false
  const out = runs.map((r) => {
    if (r.kind !== 'text') {
      state = 'text'
      return r
    }
    let text = ''
    for (const ch of r.text) {
      if ((state === 'space' || state === 'extra') && ch === ' ') {
        if (state === 'space') count++
        state = 'extra'
        changed = true
        continue
      }
      if (SENTENCE_END.has(ch)) state = 'end'
      else if (state === 'end' && CLOSERS.has(ch)) state = 'end'
      else if (state === 'end' && ch === ' ') state = 'space'
      else state = 'text'
      text += ch
    }
    return text === r.text ? r : { ...r, text }
  })
  // A run left empty (it held only extra spaces) is dropped.
  return { runs: changed ? (out.filter((r) => r.kind !== 'text' || r.text !== '') as R[]) : (runs as R[]), count }
}

function blocksSpaces(list: readonly ManuscriptBlock[], fix: boolean): { blocks: ManuscriptBlock[]; count: number } {
  let count = 0
  let changed = false
  const blocks = list.map((b) => {
    if (b.kind !== 'paragraph') return b
    const r = scanRuns(b.runs)
    count += r.count
    if (!fix || r.runs === b.runs) return b
    changed = true
    return { ...b, runs: r.runs }
  })
  return { blocks: changed ? blocks : (list as ManuscriptBlock[]), count }
}

/** How many places have two or more spaces after a full stop (body, headings and footnotes). */
export function countDoubleSpaces(ir: ManuscriptIR): number {
  let n = blocksSpaces(ir.frontMatter, false).count
  for (const c of ir.chapters) n += scanRuns(c.number).count + scanRuns(c.title).count + blocksSpaces(c.blocks, false).count
  for (const f of ir.footnotes) n += scanRuns(f.runs).count
  return n
}

/**
 * The IR with every gap of two or more spaces after a full stop made one space: for the export only
 * (the manuscript keeps its spaces). Parts without such a gap are the same objects; the input is not
 * changed.
 */
export function normalizeSentenceSpaces(ir: ManuscriptIR): ManuscriptIR {
  if (countDoubleSpaces(ir) === 0) return ir
  return {
    ...ir,
    frontMatter: blocksSpaces(ir.frontMatter, true).blocks,
    chapters: ir.chapters.map((c) => ({
      ...c,
      number: scanRuns(c.number).runs,
      title: scanRuns(c.title).runs,
      blocks: blocksSpaces(c.blocks, true).blocks,
    })),
    footnotes: ir.footnotes.map((f) => ({ ...f, runs: scanRuns(f.runs).runs })),
  }
}
