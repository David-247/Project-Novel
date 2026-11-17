import type { Node as PMNode } from '@tiptap/pm/model'
import { chapterRoles, type ResolvedStyles } from '@/shared/book'
import { currentMarkupView, isBlockHidden, type MarkupView } from '@/shared/track-changes'
import { blockPlainText } from '../block-text'
import { renderedStyleId } from '../styles/block-styles'
import { getResolvedStyles } from '../styles/resolved'

export interface Chapter {
  /** 0-based position among the chapters. */
  index: number
  /** Text of the chapter title block, without footnote text ('' when empty). */
  title: string
  /** Document position where the chapter starts (a top-level block boundary). */
  from: number
  /** Document position where it ends: the start of the next chapter, or the end of the document. */
  to: number
}

/** Chapter index of content before the first chapter (front matter). */
export const FRONT_MATTER_INDEX = -1

/**
 * Chapters of a document, derived from its top-level chapter title blocks: blocks whose rendered style
 * is a chapter title style (`chapterRoles`: Chapter Title, a style based on it such as its duplicate,
 * at outline level 1; a level-1 heading with no style is Chapter Title, the Phase 1 mapping). A chapter
 * number block (Chapter Number, or a style based on it) directly before a title belongs to the chapter
 * it introduces. Content before the first chapter is front matter (`FRONT_MATTER_INDEX`).
 * Depends on the style sheet: `styles` defaults to the current book's. Pure otherwise; O(top-level blocks).
 * Track changes: follows `markupView` (default: the current one): a title block the view hides opens
 * no chapter, and titles leave out hidden text (running heads show what the page shows).
 */
export function getChapters(doc: PMNode, styles: ResolvedStyles = getResolvedStyles(), markupView: MarkupView = currentMarkupView()): Chapter[] {
  const roles = chapterRoles(styles)
  const chapters: Chapter[] = []
  let numberFrom = -1
  doc.forEach((node, offset) => {
    if (markupView !== 'all' && isBlockHidden(node, markupView)) return
    const styled = node.type.name === 'paragraph' || node.type.name === 'heading'
    const role = styled ? roles.get(renderedStyleId(node, styles)) : undefined
    if (role === 'number') {
      if (numberFrom < 0) numberFrom = offset
      return
    }
    if (role === 'title') {
      chapters.push({ index: chapters.length, title: blockPlainText(node, { markupView }), from: numberFrom >= 0 ? numberFrom : offset, to: doc.content.size })
    }
    numberFrom = -1
  })
  for (let i = 0; i + 1 < chapters.length; i++) chapters[i].to = chapters[i + 1].from
  return chapters
}

/** Index of the chapter containing document position `pos`; `FRONT_MATTER_INDEX` before the first. */
export function chapterIndexAt(chapters: readonly Chapter[], pos: number): number {
  let found = FRONT_MATTER_INDEX
  for (const c of chapters) {
    if (c.from > pos) break
    found = c.index
  }
  return found
}
