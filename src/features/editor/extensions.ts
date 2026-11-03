import type { Extensions } from '@tiptap/core'
import Bold from '@tiptap/extension-bold'
import Document from '@tiptap/extension-document'
import HardBreak from '@tiptap/extension-hard-break'
import Heading from '@tiptap/extension-heading'
import Italic from '@tiptap/extension-italic'
import { BulletList, ListItem, OrderedList } from '@tiptap/extension-list'
import Paragraph from '@tiptap/extension-paragraph'
import Text from '@tiptap/extension-text'
import { FontFamily, TextStyle } from '@tiptap/extension-text-style'
import Underline from '@tiptap/extension-underline'
import { UndoRedo } from '@tiptap/extensions'

/**
 * Phase 1 base schema.
 * Nodes: doc, paragraph, heading (1-3), text, hardBreak, bulletList, orderedList, listItem.
 * Marks: bold, italic, underline, textStyle (carries fontFamily).
 * Plus undo/redo history (Mod-z / Mod-Shift-z) and the FontFamily attribute.
 */
export function createEditorExtensions(): Extensions {
  return [
    Document,
    Paragraph,
    Text,
    Heading.configure({ levels: [1, 2, 3] }),
    HardBreak,
    BulletList,
    OrderedList,
    ListItem,
    Bold,
    Italic,
    Underline,
    TextStyle,
    FontFamily,
    UndoRedo,
  ]
}
