import { Extension, Node } from '@tiptap/core'
import { closeHistory } from '@tiptap/pm/history'
import { NodeSelection, TextSelection } from '@tiptap/pm/state'
import { openFootnoteEditor } from './editing'
import { FOOTNOTE_NODE, footnoteNumberingPlugin } from './numbering'

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    footnotes: {
      /** Inserts a footnote after the selection and opens its text for editing. */
      insertFootnote: () => ReturnType
      /** Opens the selected footnote (or the one at `pos`) for editing. */
      editFootnote: (pos?: number) => ReturnType
    }
  }
}

/** The reference mark; `open`: a click or tap opens the note in the footnote editor. */
function footnoteView(open: boolean) {
  return ({ getPos }: { getPos: (() => number | undefined) | boolean }) => {
    const dom = document.createElement('sup')
    dom.className = 'nv-fn-ref'
    dom.setAttribute('data-footnote-ref', '')
    dom.setAttribute('role', 'doc-noteref')
    dom.contentEditable = 'false'
    // A click or tap (on the 32 px target around the mark) opens the note.
    if (open)
      dom.addEventListener('click', (e) => {
        const pos = typeof getPos === 'function' ? getPos() : undefined
        if (typeof pos !== 'number') return
        e.preventDefault()
        openFootnoteEditor(pos)
      })
    return {
      dom,
      update: (node: { type: { name: string } }) => node.type.name === FOOTNOTE_NODE,
      ignoreMutation: () => true,
    }
  }
}

/**
 * Footnote: an inline atom at the reference point. Its content (text with marks) is the note text,
 * so the note travels with its reference through copy/paste, undo, save and recovery, and find &
 * replace searches and replaces it (find/search.ts); deleting the reference deletes the note in the
 * same step. The reference shows only
 * its derived number (numbering.ts); the text is drawn at the bottom of the page by the footnotes
 * slice and edited in the anchored footnote editor.
 *
 * manuscript.json: `{ "type": "footnote", "content": [{ "type": "text", "text": "..." }] }`.
 * Marks are allowed on the reference and inside the note (room for comment / track-change marks).
 */
export const FootnoteNode = Node.create({
  name: FOOTNOTE_NODE,
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,
  content: 'text*',
  parseHTML: () => [{ tag: 'sup[data-footnote]' }],
  renderHTML: () => ['sup', { 'data-footnote': '', class: 'nv-fn-ref' }, 0],
  // Plain-text copies keep the body text only (the note would run into the sentence).
  renderText: () => '',
  addNodeView: () => footnoteView(true),
})

/**
 * Footnotes: the node, Insert Footnote (Mod-Alt-f), Enter on a selected reference to edit its note,
 * and the numbering plugin.
 */
/** For a detached view (another editor with the same schema): the mark only, the note does not open. */
const DetachedFootnoteNode = FootnoteNode.extend({ addNodeView: () => footnoteView(false) })

export const Footnotes = Extension.create<{ detached: boolean }>({
  name: 'footnotes',
  addOptions: () => ({ detached: false }),
  addExtensions() {
    return [this.options.detached ? DetachedFootnoteNode : FootnoteNode]
  },

  addCommands() {
    return {
      insertFootnote:
        () =>
        ({ tr, state, dispatch }) => {
          const type = state.schema.nodes[FOOTNOTE_NODE]
          const { $to } = tr.selection
          const at = $to.pos
          if (!$to.parent.inlineContent || !$to.parent.canReplaceWith($to.index(), $to.index(), type)) return false
          if (!dispatch) return true
          closeHistory(tr)
          tr.insert(at, type.create())
          tr.setSelection(TextSelection.create(tr.doc, at + 2))
          // The transaction is dispatched when the command returns: open the note right after.
          queueMicrotask(() => openFootnoteEditor(at))
          return true
        },
      editFootnote:
        (pos) =>
        ({ state, dispatch }) => {
          const sel = state.selection
          const at = pos ?? (sel instanceof NodeSelection && sel.node.type.name === FOOTNOTE_NODE ? sel.from : -1)
          if (at < 0 || state.doc.nodeAt(at)?.type.name !== FOOTNOTE_NODE) return false
          if (dispatch) openFootnoteEditor(at)
          return true
        },
    }
  },

  addKeyboardShortcuts() {
    if (this.options.detached) return {} as Record<string, () => boolean>
    return {
      'Mod-Alt-f': () => this.editor.commands.insertFootnote(),
      Enter: () => {
        const sel = this.editor.state.selection
        return sel instanceof NodeSelection && sel.node.type.name === FOOTNOTE_NODE && this.editor.commands.editFootnote()
      },
    }
  },

  addProseMirrorPlugins() {
    // Detached views number their own references but do not notify the footnotes area listeners.
    return [footnoteNumberingPlugin({ notify: !this.options.detached })]
  },
})
