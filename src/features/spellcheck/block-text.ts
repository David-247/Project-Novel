import type { Node as PMNode } from '@tiptap/pm/model'
import { FOOTNOTE_NODE } from '@/features/editor'
import { isBlockHidden, isInlineHidden } from '@/shared/track-changes'

/**
 * The text of one textblock as the spell checker reads it, and the way back to document positions.
 *
 * The text is the block as No Markup shows it (decision 1cedc290, like export): tracked deletions are
 * left out, tracked insertions kept. Footnote references are left out (the note is not part of the
 * sentence; an atom has no text of its own). A hard break reads as '\n' so the words on either side
 * stay apart. Any other inline atom is left out.
 *
 * Offsets are UTF-16 code units, which is what both JavaScript strings and ProseMirror positions count
 * inside a text node, so within one segment `pos = segment.pos + (offset - segment.offset)`.
 */
export interface TextSegment {
  /** Where the segment starts in the block text. */
  offset: number
  /** The document position of that character. */
  pos: number
  length: number
}

export interface CheckText {
  text: string
  /** In text order; text[offset, offset + length) is doc[pos, pos + length). Gaps in the doc are hidden content. */
  segments: TextSegment[]
}

/** No Markup: the view whose text is checked. */
const VIEW = 'none'

/** The text of `block` (a textblock at `blockPos`, the position before it) and its segments. */
export function blockCheckText(block: PMNode, blockPos: number): CheckText {
  const segments: TextSegment[] = []
  let text = ''
  if (isBlockHidden(block, VIEW)) return { text, segments }
  const push = (pos: number, chunk: string) => {
    const last = segments[segments.length - 1]
    // Adjacent runs (a bold word, a comment) are one segment: fewer to search.
    if (last && last.pos + last.length === pos && last.offset + last.length === text.length) last.length += chunk.length
    else segments.push({ offset: text.length, pos, length: chunk.length })
    text += chunk
  }
  block.forEach((child, offset) => {
    const pos = blockPos + 1 + offset
    if (isInlineHidden(child, VIEW)) return
    if (child.isText) push(pos, child.text ?? '')
    else if (child.type.name === FOOTNOTE_NODE) return
    else if (child.type.name === 'hardBreak') push(pos, '\n')
  })
  return { text, segments }
}

/**
 * The document range of block text [start, end), or null when it cannot be placed (out of range, or
 * empty). A range across hidden content (a tracked deletion, a footnote reference) spans it.
 */
export function textRangeToDoc(segments: readonly TextSegment[], start: number, end: number): { from: number; to: number } | null {
  if (end <= start) return null
  const first = segments.find((s) => start >= s.offset && start < s.offset + s.length)
  let last: TextSegment | undefined
  for (const s of segments) if (end > s.offset && end <= s.offset + s.length) last = s
  if (!first || !last) return null
  return { from: first.pos + (start - first.offset), to: last.pos + (end - last.offset) }
}

/** Whether block text [start, end) lies in one segment: the document holds exactly that text there. */
export function isContiguous(segments: readonly TextSegment[], start: number, end: number): boolean {
  return segments.some((s) => start >= s.offset && end <= s.offset + s.length)
}
