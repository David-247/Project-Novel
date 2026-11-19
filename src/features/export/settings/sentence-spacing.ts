/**
 * The manuscript's sentence spacing, shared by both generators (DOCX and PDF) so the two files of one
 * export break their lines the same way. A leaf module (no imports): it runs in the export worker.
 *
 * - Standard (`sentenceSpacing: 1`): the text is left as typed. Only the wizard's "Export one space
 *   after a full stop" option (`checks.normalizeSpaces`, applied to the IR) changes typed spaces.
 * - Classic (`sentenceSpacing: 2`): `classicSentenceSpacing` gives every single space after a
 *   sentence's end a second one. Spaces the writer already doubled are kept.
 */

/**
 * Abbreviations a period does not end a sentence after (Classic spacing must not write "Mr.  Smith").
 * Single capital initials ("J. R. R.") are handled by the pattern.
 */
const ABBREVIATIONS = new Set(['mr', 'mrs', 'ms', 'mx', 'dr', 'st', 'jr', 'sr', 'prof', 'rev', 'gen', 'col', 'capt', 'lt', 'sgt', 'mt', 'vs', 'etc', 'no', 'vol', 'fig', 'messrs', 'mme', 'mlle'])

/** End of a sentence: . ! ? (or …), then closing quotes or brackets. */
const SENTENCE_END = /([.!?…])(["'”’)\]]*)$/u
/** A single space followed by what can start a sentence (capital, digit, opening quote or bracket). */
const SENTENCE_GAP = /([.!?…]["'”’)\]]*) (?=["'“‘([]?[\p{Lu}\p{N}])/gu

function endsSentence(before: string): boolean {
  const m = SENTENCE_END.exec(before)
  if (!m) return false
  if (m[1] !== '.') return true
  const word = /(\p{L}+)\.["'”’)\]]*$/u.exec(before)?.[1]
  if (!word) return true
  if (word.length === 1 && /\p{Lu}/u.test(word)) return false // an initial
  return !ABBREVIATIONS.has(word.toLowerCase())
}

/** How much text before a sentence gap is looked at (longer than any abbreviation with its quotes). */
const CONTEXT = 64

/**
 * Classic spacing over the runs of one paragraph, as one text: a gap that spans runs ("night" + "."
 * in one run, " " in the next, "She" in a third) is found like any other. `texts[i]` is a text run's
 * text, '' for a run that holds no text (a footnote reference: the sentence before it stays ended),
 * or null for a line break (a sentence never continues across it). Returns the texts in the same
 * order, each with its second spaces added (nulls stay null). Linear in the paragraph's length.
 */
export function classicSentenceSpacing(texts: readonly (string | null)[]): (string | null)[] {
  // A line break is a newline here: no gap pattern spans it.
  const joined = texts.map((t) => t ?? '\n').join('')
  const gaps: number[] = []
  for (const m of joined.matchAll(SENTENCE_GAP)) {
    const end = m[1]
    const offset = m.index
    // Only the last word and its punctuation decide; a bounded tail keeps a long paragraph linear.
    if (endsSentence(joined.slice(Math.max(0, offset - CONTEXT), offset) + end)) gaps.push(offset + end.length)
  }
  if (gaps.length === 0) return [...texts]
  let pos = 0
  let k = 0
  return texts.map((t) => {
    if (t === null) {
      pos += 1
      return null
    }
    const start = pos
    pos += t.length
    if (k >= gaps.length || gaps[k] >= pos) return t
    let out = ''
    let last = 0
    while (k < gaps.length && gaps[k] < pos) {
      const cut = gaps[k] - start + 1 // after the gap's space
      out += `${t.slice(last, cut)} `
      last = cut
      k++
    }
    return out + t.slice(last)
  })
}

/** `classicSentenceSpacing` of a single text. */
export function doubleSentenceSpaces(text: string): string {
  return classicSentenceSpacing([text])[0] as string
}
