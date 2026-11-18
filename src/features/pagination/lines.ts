import { getEngine } from './engine'

/**
 * Lines as laid out on the pages (Word Count's "Lines"): the whole manuscript, or the lines touched by
 * the document range `[from, to)` (a selection). Null when no paginated view has laid the book out.
 * Body text only: footnote areas and running heads are not in the stream.
 */
export function countLines(range?: { from: number; to: number }): number | null {
  const engine = getEngine()
  if (!engine) return null
  return range ? engine.countLines(range.from, range.to) : engine.countLines()
}
