import type { ChainedCommands, Editor } from '@tiptap/core'

/**
 * Command chain for applying a text-style mark from a toolbar select.
 * At a bare caret the mark becomes a *stored* mark, which ProseMirror drops on the next
 * selection change (e.g. clicking back into the text). So for an empty selection we return
 * focus to the editor without moving the selection (`focus()` keeps stored marks), letting
 * the user type straight on in the chosen style. With a range selected, focus stays on the
 * select so keyboard users can keep browsing values.
 */
export function markChain(editor: Editor): ChainedCommands {
  return editor.state.selection.empty ? editor.chain().focus() : editor.chain()
}
