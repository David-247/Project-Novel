/**
 * Word counting rules (pure, DOM-free; docs/word-count.md). Shared by the editor slice (the live
 * counts in the status bar and the Word Count dialog), the outline pane and the export wizard, so
 * every count in the app follows one set of rules, modelled on Microsoft Word's:
 *
 * - A **word** is a run of non-space characters that holds at least one letter or digit (any
 *   script). Hyphens, unspaced em / en dashes, slashes, apostrophes and ellipses inside a run keep it
 *   one word ("well-known", "waited—nothing", "and/or"); punctuation standing alone between spaces is
 *   no word ("—", "*", "…"); numbers are words ("1902", "1,250.50", "$5").
 * - **Spaces** are every Unicode white space (`\s`: space, tab, no-break and thin spaces, the
 *   ideographic space) and line breaks.
 * - **Characters (with spaces)** count code points, line breaks excepted; **characters (no spaces)**
 *   leave out every space as well. Paragraph marks are never characters.
 * - A **paragraph** is a paragraph with at least one non-space character (Word leaves empty ones out).
 *
 * The text given here is already "as it reads": the caller resolves tracked changes (accepted),
 * footnotes and comments, and feeds one paragraph at a time.
 */

export interface TextCounts {
  words: number
  /** Code points other than spaces and line breaks. */
  charactersNoSpaces: number
  /** Code points other than line breaks. */
  charactersWithSpaces: number
  /** Paragraphs holding at least one non-space character. */
  paragraphs: number
}

export const ZERO_COUNTS: Readonly<TextCounts> = Object.freeze({ words: 0, charactersNoSpaces: 0, charactersWithSpaces: 0, paragraphs: 0 })

export function addCounts(a: TextCounts, b: TextCounts): TextCounts {
  return {
    words: a.words + b.words,
    charactersNoSpaces: a.charactersNoSpaces + b.charactersNoSpaces,
    charactersWithSpaces: a.charactersWithSpaces + b.charactersWithSpaces,
    paragraphs: a.paragraphs + b.paragraphs,
  }
}

export function sameCounts(a: TextCounts | null | undefined, b: TextCounts | null | undefined): boolean {
  if (!a || !b) return a === b
  return a.words === b.words && a.charactersNoSpaces === b.charactersNoSpaces && a.charactersWithSpaces === b.charactersWithSpaces && a.paragraphs === b.paragraphs
}

const SPACE = /\s/u
const WORDISH = /[\p{L}\p{N}]/u
const isBreak = (ch: string) => ch === '\n' || ch === '\r'

/** A run of non-space characters is a word when it holds a letter or a digit. */
export function isWordToken(token: string): boolean {
  return WORDISH.test(token)
}

/** One paragraph's text, summarized: its counts, and what a join at either end would glue. */
export interface ParagraphText {
  words: number
  charactersNoSpaces: number
  charactersWithSpaces: number
  /** Holds a non-space character. */
  nonEmpty: boolean
  /** The paragraph starts with a non-space run: whether that run is a word. Null when it starts with a space (or is empty). */
  lead: boolean | null
  /** The same for the run it ends with. */
  trail: boolean | null
  /** The whole paragraph is one run (no space in it, not empty). */
  single: boolean
}

/** Summarize one paragraph of plain text (one pass over its code points). */
export function summarizeParagraph(text: string): ParagraphText {
  let words = 0
  let noSpaces = 0
  let withSpaces = 0
  let inRun = false
  let runIsWord = false
  let lead: boolean | null = null
  let leadOpen = true
  let sawSpace = false
  for (const ch of text) {
    if (isBreak(ch) || SPACE.test(ch)) {
      if (!isBreak(ch)) withSpaces++
      if (inRun) {
        if (runIsWord) words++
        if (leadOpen) lead = runIsWord
        inRun = false
      }
      leadOpen = false
      sawSpace = true
      continue
    }
    withSpaces++
    noSpaces++
    if (!inRun) {
      inRun = true
      runIsWord = false
    }
    if (!runIsWord && WORDISH.test(ch)) runIsWord = true
  }
  let trail: boolean | null = null
  if (inRun) {
    if (runIsWord) words++
    if (leadOpen) lead = runIsWord
    trail = runIsWord
  }
  const nonEmpty = noSpaces > 0
  return { words, charactersNoSpaces: noSpaces, charactersWithSpaces: withSpaces, nonEmpty, lead, trail, single: nonEmpty && !sawSpace }
}

/** Counts of plain text taken as one paragraph. */
export function countText(text: string): TextCounts {
  const p = summarizeParagraph(text)
  return { words: p.words, charactersNoSpaces: p.charactersNoSpaces, charactersWithSpaces: p.charactersWithSpaces, paragraphs: p.nonEmpty ? 1 : 0 }
}

/**
 * Running counts over paragraphs in reading order. A paragraph can **join** the one before it (a
 * tracked deletion of the paragraph mark, accepted: "fo¶ar" reads "foar"): it then adds no paragraph
 * of its own, and its first run glues to the last run before it.
 */
export interface Tally {
  counts: TextCounts
  /** Whether a paragraph came before (something to join to). */
  hasPrevious: boolean
  /** The previous paragraph (after its joins) has a non-space character. */
  previousNonEmpty: boolean
  /** It ends with a non-space run: whether that run is a word; null when it ends with a space or is empty. */
  trail: boolean | null
}

export function createTally(): Tally {
  return { counts: { ...ZERO_COUNTS }, hasPrevious: false, previousNonEmpty: false, trail: null }
}

/**
 * Add a paragraph. `joinsPrevious`: its paragraph mark before it is deleted (accepted). A joining
 * paragraph with no non-space text goes away (accepting removes an emptied paragraph); the first
 * paragraph has nothing to join and counts on its own.
 */
export function appendParagraph(t: Tally, p: ParagraphText, joinsPrevious: boolean): void {
  const c = t.counts
  c.charactersNoSpaces += p.charactersNoSpaces
  c.charactersWithSpaces += p.charactersWithSpaces
  if (joinsPrevious && t.hasPrevious) {
    if (!p.nonEmpty) {
      // Only spaces (or nothing): they join the paragraph before, gluing nothing.
      if (p.charactersWithSpaces > 0) t.trail = null
      return
    }
    let words = p.words
    let glued: boolean | null = null
    if (t.trail !== null && p.lead !== null) {
      glued = t.trail || p.lead
      words += (glued ? 1 : 0) - (t.trail ? 1 : 0) - (p.lead ? 1 : 0)
    }
    c.words += words
    if (!t.previousNonEmpty) c.paragraphs++
    t.previousNonEmpty = true
    t.trail = p.single && glued !== null ? glued : p.trail
    return
  }
  c.words += p.words
  if (p.nonEmpty) c.paragraphs++
  t.hasPrevious = true
  t.previousNonEmpty = p.nonEmpty
  t.trail = p.trail
}
