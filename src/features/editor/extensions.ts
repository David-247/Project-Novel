import type { Extensions } from '@tiptap/core'
import Bold from '@tiptap/extension-bold'
import Document from '@tiptap/extension-document'
import HardBreak from '@tiptap/extension-hard-break'
import Heading from '@tiptap/extension-heading'
import Italic from '@tiptap/extension-italic'
import { BulletList, ListItem, OrderedList } from '@tiptap/extension-list'
import Paragraph from '@tiptap/extension-paragraph'
import Text from '@tiptap/extension-text'
import TextAlign from '@tiptap/extension-text-align'
import { FontFamily, FontSize, TextStyle } from '@tiptap/extension-text-style'
import Underline from '@tiptap/extension-underline'
import { UndoRedo } from '@tiptap/extensions'
import { BlockFormat, BLOCK_FORMAT_TYPES } from './toolbar/block-format'

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

    // --- Formatting toolbar (task 3): additive only ---
    // textStyle.fontSize; paragraph/heading textAlign (Mod-Shift-l/e/r/j);
    // paragraph/heading lineHeight, paragraphSpacing, indent (Mod-] / Mod-[).
    FontSize,
    TextAlign.configure({ types: [...BLOCK_FORMAT_TYPES], alignments: ['left', 'center', 'right', 'justify'] }),
    BlockFormat,
    // --- end formatting toolbar ---
  ]
}
