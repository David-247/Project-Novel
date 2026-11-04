import { Extension, InputRule, Node } from '@tiptap/core'
import { closeHistory } from '@tiptap/pm/history'
import type { Node as PMNode } from '@tiptap/pm/model'
import { NodeSelection, Plugin, TextSelection } from '@tiptap/pm/state'
import type { Transaction } from '@tiptap/pm/state'
import { STYLE_IDS } from '@/shared/book'
import { effectiveStyleId, restyleBlock } from '../styles/block-styles'
import { getResolvedStyles } from '../styles/resolved'
import { mapPastedHtml } from './paste'

/** Scene break ornaments: the value is the text shown ('' = blank line). */
export const SCENE_ORNAMENTS = [
  { value: '* * *', label: '* * *' },
  { value: '#', label: '#' },
  { value: '❦', label: '❦' },
  { value: '', label: 'Blank line' },
] as const
export const DEFAULT_ORNAMENT = '* * *'

let newOrnament = DEFAULT_ORNAMENT
/** Ornament used by the next scene break inserted from the menu or shortcut. */
export const getNewSceneBreakOrnament = () => newOrnament
export const setNewSceneBreakOrnament = (value: string) => {
  newOrnament = value
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    bookBreaks: {
      /** Inserts a page break after the current block; the text after it starts a new page. */
      insertPageBreak: () => ReturnType
      /** Inserts an empty Chapter Title block at the cursor (an empty paragraph becomes one). */
      insertChapter: () => ReturnType
      /** Inserts a scene break (the ornament defaults to the menu choice); the next paragraph uses First Paragraph. */
      insertSceneBreak: (ornament?: string) => ReturnType
      /** Changes the ornament of the selected scene break. */
      setSceneBreakOrnament: (ornament: string) => ReturnType
    }
  }
}

/** Page break: a block atom. Pagination breaks before the FOLLOWING block (see computeBreaks). */
export const PageBreak = Node.create({
  name: 'pageBreak',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: false,
  parseHTML: () => [{ tag: 'div[data-page-break]' }],
  renderHTML: () => ['div', { 'data-page-break': '', 'data-label': 'Page break', role: 'separator', 'aria-label': 'Page break' }],
})

/** Scene break: a block atom shown as a centred ornament in the Scene Break style. */
export const SceneBreak = Node.create({
  name: 'sceneBreak',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: false,
  addAttributes() {
    return {
      ornament: {
        default: DEFAULT_ORNAMENT,
        parseHTML: (el) => el.getAttribute('data-ornament') ?? DEFAULT_ORNAMENT,
        renderHTML: () => ({}),
      },
    }
  },
  parseHTML: () => [{ tag: 'div[data-scene-break]' }, { tag: 'hr' }],
  renderHTML: ({ node }) => {
    const ornament = String(node.attrs.ornament ?? '')
    return [
      'div',
      { 'data-scene-break': '', 'data-style': STYLE_IDS.sceneBreak, 'data-ornament': ornament, role: 'separator' },
      ornament || ' ',
    ]
  },
})

// ---- insertion -------------------------------------------------------------------------------

/**
 * Inserts a top-level block node at the cursor. An empty top-level text block is replaced; at the
 * end or start of a text block the node goes after or before it; inside one it splits the block;
 * inside a list or a selected atom it goes after the top-level block. Returns where it went.
 */
function insertBlock(tr: Transaction, node: PMNode): number {
  const sel = tr.selection
  let pos: number
  if (sel instanceof NodeSelection && sel.$from.depth === 0) {
    pos = sel.to
  } else {
    const { $from } = sel
    const block = $from.parent
    if ($from.depth === 1 && block.isTextblock) {
      if (block.content.size === 0) {
        const start = $from.before(1)
        tr.replaceWith(start, $from.after(1), node)
        return start
      }
      if ($from.parentOffset === 0) pos = $from.before(1)
      else if ($from.parentOffset === block.content.size) pos = $from.after(1)
      else {
        tr.split($from.pos)
        pos = $from.pos + 1 // between the two halves
      }
    } else {
      pos = $from.depth >= 1 ? $from.after(1) : tr.doc.content.size
    }
  }
  tr.insert(pos, node)
  return pos
}

/** Puts the caret in the text block following `after`, creating an empty paragraph when there is none. */
function caretAfter(tr: Transaction, after: number, firstParagraph: boolean): void {
  const styles = getResolvedStyles()
  const first = styles.get(STYLE_IDS.firstParagraph)
  const next = tr.doc.nodeAt(after)
  if (next?.isTextblock) {
    if (firstParagraph && first && next.type.name === 'paragraph' && effectiveStyleId(next) === STYLE_IDS.body) {
      restyleBlock(tr, after, first)
    }
  } else {
    const schema = tr.doc.type.schema
    tr.insert(after, schema.nodes.paragraph.create(firstParagraph && first ? { styleId: first.id } : null))
  }
  tr.setSelection(TextSelection.create(tr.doc, after + 1))
}

function doInsertPageBreak(tr: Transaction): void {
  closeHistory(tr)
  const node = tr.doc.type.schema.nodes.pageBreak.create()
  caretAfter(tr, insertBlock(tr, node) + node.nodeSize, false)
}

function doInsertSceneBreak(tr: Transaction, ornament: string): void {
  closeHistory(tr)
  const node = tr.doc.type.schema.nodes.sceneBreak.create({ ornament })
  caretAfter(tr, insertBlock(tr, node) + node.nodeSize, true)
}

function doInsertChapter(tr: Transaction): boolean {
  const style = getResolvedStyles().get(STYLE_IDS.chapterTitle)
  if (!style) return false
  closeHistory(tr)
  const { $from } = tr.selection
  if ($from.depth === 1 && $from.parent.type.name === 'paragraph' && $from.parent.content.size === 0) {
    return restyleBlock(tr, $from.before(1), style)
  }
  const node = tr.doc.type.schema.nodes.heading.create({ level: style.outlineLevel ?? 1, styleId: style.id })
  const pos = insertBlock(tr, node)
  tr.setSelection(TextSelection.create(tr.doc, pos + 1))
  return true
}

/**
 * Book structure: page break and scene break nodes, the New chapter command, their shortcuts
 * (Mod-Enter, Mod-Shift-Enter, Mod-Alt-Enter), the `***` / `###` scene break input rules and the
 * paste mapping (`page-break-before` -> page break; `<hr>` -> scene break).
 */
export const BookBreaks = Extension.create({
  name: 'bookBreaks',
  // Above HardBreak's Mod-Enter and the core keymap.
  priority: 1150,

  addExtensions: () => [PageBreak, SceneBreak],

  addCommands() {
    return {
      insertPageBreak:
        () =>
        ({ tr, dispatch }) => {
          if (dispatch) doInsertPageBreak(tr)
          return true
        },
      insertChapter:
        () =>
        ({ tr, dispatch }) => {
          if (!dispatch) return Boolean(getResolvedStyles().get(STYLE_IDS.chapterTitle))
          return doInsertChapter(tr)
        },
      insertSceneBreak:
        (ornament) =>
        ({ tr, dispatch }) => {
          if (dispatch) doInsertSceneBreak(tr, ornament ?? newOrnament)
          return true
        },
      setSceneBreakOrnament:
        (ornament) =>
        ({ tr, state, dispatch }) => {
          const sel = state.selection
          if (!(sel instanceof NodeSelection) || sel.node.type.name !== 'sceneBreak') return false
          if (dispatch) tr.setNodeMarkup(sel.from, undefined, { ...sel.node.attrs, ornament })
          return true
        },
    }
  },

  addKeyboardShortcuts() {
    return {
      'Mod-Enter': () => this.editor.commands.insertPageBreak(),
      'Mod-Shift-Enter': () => this.editor.commands.insertChapter(),
      'Mod-Alt-Enter': () => this.editor.commands.insertSceneBreak(),
    }
  },

  addInputRules() {
    const rule = (find: RegExp, ornament: string) =>
      new InputRule({
        find,
        handler: ({ state, range }) => {
          const { $from } = state.selection
          // Alone on its line: a top-level paragraph holding nothing but what was typed.
          if ($from.depth !== 1 || $from.parent.type.name !== 'paragraph' || $from.parent.content.size !== range.to - range.from) {
            return null
          }
          const tr = state.tr
          closeHistory(tr) // the conversion is one undo step, apart from the typing before it
          tr.delete(range.from, range.to)
          doInsertSceneBreak(tr, ornament)
          return undefined
        },
      })
    return [rule(/^\*\*\*$/, '* * *'), rule(/^###$/, '#')]
  },

  addProseMirrorPlugins() {
    return [new Plugin({ props: { transformPastedHTML: mapPastedHtml } })]
  },
})
