// TEST-ONLY helpers for the harness tests: a headless manuscript editor and JSON builders.
import { Editor, type JSONContent } from '@tiptap/core'
import { createEditorExtensions } from '@/features/editor'

const stamp = { id: 'c1', author: 'Ann', date: '2026-01-01T00:00:00.000Z', authorColor: null }

export const t = (text: string, marks?: JSONContent['marks']): JSONContent => ({ type: 'text', text, ...(marks ? { marks } : {}) })
export const p = (...content: JSONContent[]): JSONContent => ({ type: 'paragraph', content })
/** A chapter title (a level-1 heading without a style is Chapter Title). */
export const h1 = (text: string): JSONContent => ({ type: 'heading', attrs: { level: 1 }, content: [t(text)] })
export const note = (text: string): JSONContent => ({ type: 'footnote', content: [t(text)] })
export const deleted = [{ type: 'deletion', attrs: stamp }]
export const inserted = [{ type: 'insertion', attrs: { ...stamp, id: 'c2' } }]

/** A headless editor holding `content` (top-level blocks). */
export function makeEditor(...content: JSONContent[]): Editor {
  return new Editor({ element: document.createElement('div'), extensions: createEditorExtensions(), content: { type: 'doc', content } })
}

/** The position just before the first textblock whose text contains `needle`. */
export function blockPosOf(editor: Editor, needle: string): number {
  let found = -1
  editor.state.doc.descendants((node, pos) => {
    if (found >= 0) return false
    if (node.isTextblock && node.textContent.includes(needle)) {
      found = pos
      return false
    }
    return true
  })
  if (found < 0) throw new Error(`no block holds "${needle}"`)
  return found
}

/** The document position of the first occurrence of `needle` inside a text node. */
export function textPosOf(editor: Editor, needle: string): number {
  let found = -1
  editor.state.doc.descendants((node, pos) => {
    if (found >= 0) return false
    if (node.isText && node.text!.includes(needle)) found = pos + node.text!.indexOf(needle)
    return true
  })
  if (found < 0) throw new Error(`no text "${needle}"`)
  return found
}
