import { runsText, type ManuscriptBlock, type ManuscriptIR } from '../ir'

/**
 * The front matter's own title block, left out when the export prints a generated title page (coordinator
 * ruling, Phase 4 Wave 2): otherwise the title, "A novel" and the by-line would print twice, once on the
 * title page and again on the next page.
 *
 * Recognised only at the very start of the front matter (page / section breaks before it are skipped):
 * - a paragraph whose text is the manuscript title (letters and digits compared, case-insensitive), then
 * - right after it, at most one subtitle ("A novel", "A thriller novel", "Novel", "A Novel by <name>") and at
 *   most one by-line ("by <name>" or the name alone), in either order.
 * `<name>` is the pen name or the legal name; without either, a short "by ..." line (five words or fewer,
 * no clause punctuation) counts. Anything else ends the block, and nothing is left out unless the first
 * paragraph is the title. The page / section breaks right after the block go too (the text after it starts
 * the page after the title page anyway). Pure: the input is not changed.
 */

export interface TitleBlockOptions {
  /** The manuscript title (the title page's). */
  title: string
  /** The author's names (pen name, legal name); blanks are ignored. */
  names: readonly string[]
}

const norm = (s: string) =>
  s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()

const SUBTITLE = /^(?:(?:a|an) (?:[\p{L}-]+ ){0,2})?novel$/u

const isBreak = (b: ManuscriptBlock) => b.kind === 'pageBreak' || b.kind === 'sectionBreak'

export function withoutTitleBlock(ir: ManuscriptIR, options: TitleBlockOptions): ManuscriptIR {
  const title = norm(options.title)
  if (!title) return ir
  const names = options.names.map(norm).filter(Boolean)
  const isName = (s: string) => names.includes(s)
  const isByline = (raw: string, s: string) => {
    const m = /^by (.+)$/.exec(s)
    if (!m) return isName(s)
    if (names.length) return isName(m[1])
    return m[1].split(' ').length <= 5 && !/[,;:!?]/.test(raw)
  }
  const isSubtitle = (s: string) => {
    if (SUBTITLE.test(s)) return true
    const m = /^(.*novel) by (.+)$/.exec(s)
    return m !== null && SUBTITLE.test(m[1]) && (names.length ? isName(m[2]) : m[2].split(' ').length <= 5)
  }

  const blocks = ir.frontMatter
  let i = 0
  while (i < blocks.length && isBreak(blocks[i])) i++
  const first = blocks[i]
  if (!first || first.kind !== 'paragraph' || norm(runsText(first.runs)) !== title) return ir
  i++
  let subtitle = false
  let byline = false
  while (i < blocks.length) {
    const b = blocks[i]
    if (b.kind !== 'paragraph') break
    const raw = runsText(b.runs)
    const s = norm(raw)
    if (!subtitle && isSubtitle(s)) subtitle = true
    else if (!byline && isByline(raw, s)) byline = true
    else break
    i++
  }
  while (i < blocks.length && isBreak(blocks[i])) i++
  return { ...ir, frontMatter: blocks.slice(i) }
}
