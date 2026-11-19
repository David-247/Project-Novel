import type { Node as PMNode } from '@tiptap/pm/model'
import { appendParagraph, countText, createTally, summarizeParagraph, ZERO_COUNTS, type ParagraphText, type TextCounts } from '@/shared/text'
import { acceptedText, isDeletedOnAccept, joinsPreviousOnAccept } from '@/shared/track-changes'
import type { Chapter } from '../breaks/chapters'
import { FOOTNOTE_NODE } from '../footnote/name'

/**
 * The editor slice's counting engine (docs/word-count.md): the shared rules (`@/shared/text`) applied
 * to the manuscript as it reads with every pending tracked change accepted (`@/shared/track-changes`).
 * Footnote text is counted apart from the body (a note is a paragraph of its own); its reference is no
 * character. Comments (marks plus a side file) and re-write versions (a side file) are not document
 * text, so they are never counted.
 *
 * Incremental: what a top-level block contributes is cached per immutable ProseMirror node, so after a
 * keystroke only the edited block is read again; a count is then one pass over the top-level blocks
 * adding cached numbers (joins between paragraphs are resolved in that pass).
 */

interface BlockEntry {
  /** Its textblocks in order: their accepted text, summarized, and whether each joins the one before. */
  paragraphs: { text: ParagraphText; joins: boolean }[]
  footnotes: TextCounts
}

const cache = new WeakMap<PMNode, BlockEntry>()
let recounts = 0

/** Blocks read (cache misses) so far: a test hook for "a keystroke recounts one block". */
export function wordCountRecounts(): number {
  return recounts
}

const isFootnote = (n: PMNode) => n.type.name === FOOTNOTE_NODE
const leafText = (n: PMNode) => (n.type.name === 'hardBreak' ? '\n' : undefined)

function addInto(a: TextCounts, b: TextCounts) {
  a.words += b.words
  a.charactersNoSpaces += b.charactersNoSpaces
  a.charactersWithSpaces += b.charactersWithSpaces
  a.paragraphs += b.paragraphs
}

function readBlock(block: PMNode): BlockEntry {
  recounts++
  const paragraphs: BlockEntry['paragraphs'] = []
  const footnotes = { ...ZERO_COUNTS }
  const visit = (node: PMNode) => {
    if (node.isTextblock) {
      paragraphs.push({ text: summarizeParagraph(acceptedText(node, { skip: isFootnote, leafText })), joins: joinsPreviousOnAccept(node) })
      node.forEach((child) => {
        if (isFootnote(child) && !isDeletedOnAccept(child)) addInto(footnotes, countText(acceptedText(child, { leafText })))
      })
      return
    }
    // Breaks (block atoms) hold no text; a deleted one is removed, which joins nothing.
    if (!node.isLeaf) node.forEach(visit)
  }
  visit(block)
  return { paragraphs, footnotes }
}

function entry(block: PMNode): BlockEntry {
  let e = cache.get(block)
  if (!e) {
    e = readBlock(block)
    cache.set(block, e)
  }
  return e
}

export interface BodyAndNotes {
  body: TextCounts
  footnotes: TextCounts
}

export interface ManuscriptCounts extends BodyAndNotes {
  frontMatter: BodyAndNotes
  chapters: (Chapter & BodyAndNotes)[]
}

const diff = (a: TextCounts, b: TextCounts): TextCounts => ({
  words: a.words - b.words,
  charactersNoSpaces: a.charactersNoSpaces - b.charactersNoSpaces,
  charactersWithSpaces: a.charactersWithSpaces - b.charactersWithSpaces,
  paragraphs: a.paragraphs - b.paragraphs,
})

/**
 * Counts of a document, and per chapter when `chapters` (from `getChapters`, whose ranges start at
 * top-level block boundaries) are given. A chapter's counts are the book's running count across its
 * range, so chapters and front matter always add up to the book (a paragraph joined across a chapter
 * start counts in the later chapter).
 */
export function countManuscript(doc: PMNode, chapters: readonly Chapter[] = []): ManuscriptCounts {
  const tally = createTally()
  const notes = { ...ZERO_COUNTS }
  const marks: { body: TextCounts; footnotes: TextCounts }[] = []
  let next = 0
  const mark = () => marks.push({ body: { ...tally.counts }, footnotes: { ...notes } })
  doc.forEach((block, offset) => {
    while (next < chapters.length && chapters[next].from <= offset) {
      mark()
      next++
    }
    const e = entry(block)
    for (const para of e.paragraphs) appendParagraph(tally, para.text, para.joins)
    addInto(notes, e.footnotes)
  })
  while (next < chapters.length) {
    mark()
    next++
  }
  const end = { body: tally.counts, footnotes: notes }
  const at = (i: number) => (i < marks.length ? marks[i] : end)
  const first = chapters.length ? at(0) : end
  return {
    body: tally.counts,
    footnotes: notes,
    frontMatter: { body: { ...first.body }, footnotes: { ...first.footnotes } },
    chapters: chapters.map((c, i) => ({
      ...c,
      body: diff(at(i + 1).body, at(i).body),
      footnotes: diff(at(i + 1).footnotes, at(i).footnotes),
    })),
  }
}

/**
 * Counts of the document range `[from, to)` (a selection): the blocks inside it come from the cache;
 * the partly selected blocks at its ends are cut and read. Footnotes count when their reference is in
 * the range.
 */
export function countRange(doc: PMNode, from: number, to: number): BodyAndNotes {
  const lo = Math.max(0, Math.min(from, to))
  const hi = Math.min(doc.content.size, Math.max(from, to))
  if (hi <= lo) return { body: { ...ZERO_COUNTS }, footnotes: { ...ZERO_COUNTS } }
  const { body, footnotes } = countManuscript(doc.cut(lo, hi))
  return { body, footnotes }
}
