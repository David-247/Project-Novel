/**
 * Text clean-up for WordprocessingML. The `docx` library escapes the XML specials (& < > " ');
 * this removes what XML 1.0 cannot hold at all and applies the manuscript's sentence spacing.
 */

// C0 controls other than tab / LF / CR, the non-characters U+FFFE / U+FFFF, and lone surrogates (an
// emoji is a valid surrogate pair and stays). Matching control characters is the point here.
// eslint-disable-next-line no-control-regex
const INVALID_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g

/** `text` without the characters XML 1.0 forbids (tab, LF and CR stay for the caller to map). */
export function xmlSafe(text: string): string {
  return text.replace(INVALID_XML, '')
}

/**
 * Abbreviations a period does not end a sentence after (Classic spacing must not write "Mr.  Smith").
 * Single capital initials ("J. R. R.") are handled by the pattern.
 */
const ABBREVIATIONS = new Set(['mr', 'mrs', 'ms', 'mx', 'dr', 'st', 'jr', 'sr', 'prof', 'rev', 'gen', 'col', 'capt', 'lt', 'sgt', 'mt', 'vs', 'etc', 'no', 'vol', 'fig', 'messrs', 'mme', 'mlle'])

/** End of a sentence: . ! ? (or …), then closing quotes or brackets. */
const SENTENCE_END = /([.!?…])(["'”’)\]]*)$/u
/** A space followed by what can start a sentence (capital, digit, opening quote or bracket). */
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

/**
 * Two spaces after a sentence (the Classic preset): every single space after a sentence end gets a
 * second one. `previous` is the text before `text` in the same paragraph (another run), so a space
 * that starts this run after a sentence ending the previous one counts too.
 */
export function doubleSentenceSpaces(text: string, previous = ''): string {
  let out = text.replace(SENTENCE_GAP, (match, end: string, offset: number) => {
    const before = previous + text.slice(0, offset) + end
    return endsSentence(before) ? `${end}  ` : match
  })
  if (out.startsWith(' ') && !out.startsWith('  ') && endsSentence(previous) && /^ ["'“‘([]?[\p{Lu}\p{N}]/u.test(out)) out = ` ${out}`
  return out
}
