import type { Node as PMNode } from '@tiptap/pm/model'
import { isInlineHidden, type MarkupView } from '@/shared/track-changes'
import { FOOTNOTE_NODE } from './footnote/name'

export interface BlockPlainTextOptions {
  /**
   * Track changes: leave out the text this markup view hides (deleted text in Simple / No Markup,
   * inserted text in Original). Default 'all': every character, as before.
   */
  markupView?: MarkupView
}

/**
 * The plain text of a block as a reader sees it in the running text: like `node.textContent`, but
 * without the text of footnotes (a footnote is an inline node whose content is the note, so
 * `textContent` would run the note into the sentence: "The RoadFirst told in 1902."). Use it wherever
 * a block's text is shown or reused as text: chapter titles (running heads), style proofs.
 * Search keeps its own block text (find/search.ts), which does include note text, on purpose.
 */
export function blockPlainText(node: PMNode, options: BlockPlainTextOptions = {}): string {
  const view = options.markupView ?? 'all'
  if (node.isText) return isInlineHidden(node, view) ? '' : (node.text ?? '')
  let plain = true
  node.descendants((n) => {
    if (n.type.name === FOOTNOTE_NODE || (view !== 'all' && n.marks.length && isInlineHidden(n, view))) plain = false
    return plain && !n.isText
  })
  if (plain) return node.textContent
  let out = ''
  node.descendants((n) => {
    if (n.type.name === FOOTNOTE_NODE || (n.isInline && isInlineHidden(n, view))) return false
    if (n.isText) out += n.text
    else if (n.isLeaf) {
      const leafText = n.type.spec.leafText
      if (leafText) out += leafText(n)
    }
    return true
  })
  return out
}
