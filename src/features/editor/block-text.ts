import type { Node as PMNode } from '@tiptap/pm/model'
import { FOOTNOTE_NODE } from './footnote/name'

/**
 * The plain text of a block as a reader sees it in the running text: like `node.textContent`, but
 * without the text of footnotes (a footnote is an inline node whose content is the note, so
 * `textContent` would run the note into the sentence: "The RoadFirst told in 1902."). Use it wherever
 * a block's text is shown or reused as text: chapter titles (running heads), style proofs.
 * Search keeps its own block text (find/search.ts), which does include note text, on purpose.
 */
export function blockPlainText(node: PMNode): string {
  if (node.isText) return node.text ?? ''
  let hasNote = false
  node.descendants((n) => {
    if (n.type.name === FOOTNOTE_NODE) hasNote = true
    return !hasNote && !n.isText
  })
  if (!hasNote) return node.textContent
  let out = ''
  node.descendants((n) => {
    if (n.type.name === FOOTNOTE_NODE) return false
    if (n.isText) out += n.text
    else if (n.isLeaf) {
      const leafText = n.type.spec.leafText
      if (leafText) out += leafText(n)
    }
    return true
  })
  return out
}
