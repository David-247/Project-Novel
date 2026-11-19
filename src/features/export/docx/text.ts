/**
 * Text clean-up for WordprocessingML. The `docx` library escapes the XML specials (& < > " ');
 * this removes what XML 1.0 cannot hold at all. Sentence spacing is shared with the PDF:
 * ../settings/sentence-spacing.ts.
 */

// C0 controls other than tab / LF / CR, the non-characters U+FFFE / U+FFFF, and lone surrogates (an
// emoji is a valid surrogate pair and stays). Matching control characters is the point here.
// eslint-disable-next-line no-control-regex
const INVALID_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g

/** `text` without the characters XML 1.0 forbids (tab, LF and CR stay for the caller to map). */
export function xmlSafe(text: string): string {
  return text.replace(INVALID_XML, '')
}
