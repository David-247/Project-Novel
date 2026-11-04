import type { Node as PMNode } from '@tiptap/pm/model'
import { useStore } from '@/shared/store'

/**
 * Track changes: the names and view rules every slice needs (docs/track-changes.md). The marks,
 * the recording plugin and the accept/reject core live in the track-changes slice; the editor slice
 * (find, footnote numbering, chapters, breaks) only needs to know what the current markup view
 * hides, which is decided here.
 */

/** View ▸ Markup. `all`: All Markup; `simple`: Simple Markup; `none`: No Markup; `original`: Original. */
export type MarkupView = 'all' | 'simple' | 'none' | 'original'
export const MARKUP_VIEWS: readonly MarkupView[] = ['all', 'simple', 'none', 'original']
export const DEFAULT_MARKUP_VIEW: MarkupView = 'all'

/** Inline marks. */
export const INSERTION_MARK = 'insertion'
export const DELETION_MARK = 'deletion'
export const FORMAT_CHANGE_MARK = 'formatChange'
export const TRACKING_MARKS: readonly string[] = [INSERTION_MARK, DELETION_MARK, FORMAT_CHANGE_MARK]

/** Block attributes. `trackedInsert` / `trackedDelete`: the boundary before the block was inserted / deleted. */
export const TRACKED_INSERT_ATTR = 'trackedInsert'
export const TRACKED_DELETE_ATTR = 'trackedDelete'
export const TRACKED_STYLE_ATTR = 'trackedStyleChange'
export const TRACKING_BLOCK_ATTRS: readonly string[] = [TRACKED_INSERT_ATTR, TRACKED_DELETE_ATTR, TRACKED_STYLE_ATTR]

/**
 * Transaction meta set when the markup view changes (no document change). Plugins whose output
 * depends on the view (footnote numbers, data-break-before, find highlights) recompute on it.
 */
export const MARKUP_VIEW_META = 'nvMarkupView'

/** Deleted text is hidden (the final text is shown). */
export const hidesDeletions = (view: MarkupView): boolean => view === 'simple' || view === 'none'
/** Inserted text is hidden (the original text is shown). */
export const hidesInsertions = (view: MarkupView): boolean => view === 'original'

/** The view in the store now (All Markup when the store has none, e.g. in an isolated test). */
export function currentMarkupView(): MarkupView {
  return useStore.getState().trackChanges?.markupView ?? DEFAULT_MARKUP_VIEW
}

const hasMark = (node: PMNode, name: string) => node.marks.some((m) => m.type.name === name)

/** An inline node (text, footnote reference, hard break) that `view` does not show. */
export function isInlineHidden(node: PMNode, view: MarkupView): boolean {
  if (view === 'all' || node.marks.length === 0) return false
  if (hidesDeletions(view)) return hasMark(node, DELETION_MARK)
  return hidesInsertions(view) && hasMark(node, INSERTION_MARK)
}

/**
 * A block that `view` does not show at all: a deleted block (`trackedDelete`) whose content is all
 * deleted, in Simple / No Markup; an inserted block (`trackedInsert`) whose content is all inserted,
 * in Original. Such a block takes no space on the page (it is what accepting / rejecting leaves).
 */
export function isBlockHidden(node: PMNode, view: MarkupView): boolean {
  if (view === 'all') return false
  const attr = hidesDeletions(view) ? TRACKED_DELETE_ATTR : TRACKED_INSERT_ATTR
  if (!node.attrs[attr]) return false
  if (node.isLeaf) return true
  if (!node.inlineContent) return false
  let all = true
  node.forEach((child) => {
    if (all && !isInlineHidden(child, view)) all = false
  })
  return all
}
