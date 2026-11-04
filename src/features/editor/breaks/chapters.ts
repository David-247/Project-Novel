import type { Node as PMNode } from '@tiptap/pm/model'
import { STYLE_IDS } from '@/shared/book'
import { effectiveStyleId } from '../styles/block-styles'

export interface Chapter {
  /** 0-based position among the chapters. */
  index: number
  /** Text of the Chapter Title block ('' when empty). */
  title: string
  /** Document position where the chapter starts (a top-level block boundary). */
  from: number
  /** Document position where it ends: the start of the next chapter, or the end of the document. */
  to: number
}

/** Chapter index of content before the first chapter (front matter). */
export const FRONT_MATTER_INDEX = -1

/**
 * Chapters of a document, derived from its top-level Chapter Title blocks (a level-1 heading with no
 * style also counts: the Phase 1 mapping). A Chapter Number block directly before a title belongs to
 * the chapter it introduces. Content before the first chapter is front matter (`FRONT_MATTER_INDEX`).
 * Pure; O(top-level blocks).
 */
export function getChapters(doc: PMNode): Chapter[] {
  const chapters: Chapter[] = []
  let numberFrom = -1
  doc.forEach((node, offset) => {
    const styled = node.type.name === 'paragraph' || node.type.name === 'heading'
    const id = styled ? effectiveStyleId(node) : null
    if (id === STYLE_IDS.chapterNumber) {
      if (numberFrom < 0) numberFrom = offset
      return
    }
    if (id === STYLE_IDS.chapterTitle) {
      chapters.push({ index: chapters.length, title: node.textContent, from: numberFrom >= 0 ? numberFrom : offset, to: doc.content.size })
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
