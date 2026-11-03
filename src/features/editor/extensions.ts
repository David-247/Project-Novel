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
import { FindHighlight } from './find/plugin'
import { BlockStyles } from './styles/block-styles'

/**
 * Phase 1 base schema.
 * Nodes: doc, paragraph, heading (1-3), text, hardBreak, bulletList, orderedList, listItem.
 * Marks: bold, italic, underline, textStyle (carries fontFamily).
 * Plus undo/redo history (Mod-z / Mod-Shift-z / Mod-y), find highlighting and the FontFamily attribute.
 */
/** Undo history depth: effectively unlimited (see the task 4 block below). */
export const HISTORY_DEPTH = Number.MAX_SAFE_INTEGER

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

    // --- Formatting toolbar (task 3): additive only ---
    // textStyle.fontSize; paragraph/heading textAlign (Mod-Shift-l/e/r/j);
    // paragraph/heading lineHeight, paragraphSpacing, indent (Mod-] / Mod-[).
    FontSize,
    TextAlign.configure({ types: [...BLOCK_FORMAT_TYPES], alignments: ['left', 'center', 'right', 'justify'] }),
    BlockFormat,
    // --- end formatting toolbar ---

    // --- History + find/replace (task 4) ---------------------------------------------------
    // Undo depth is effectively unlimited (spec: no cap). Memory grows with the number of
    // undo events in the session (each holds its steps + inverted maps, roughly proportional
    // to the text changed); it is released when a document is loaded (setDocJSON resets
    // history). Typing is grouped into events by `newGroupDelay` (500 ms default).
    // Shortcuts (from UndoRedo): Mod-z undo; Mod-Shift-z and Mod-y redo.
    UndoRedo.configure({ depth: HISTORY_DEPTH }),
    // Search-result highlighting + Mod-f (open find) / Escape (close find).
    FindHighlight,
    // --- end task 4 -----------------------------------------------------------------------

    // --- Paragraph and chapter styles (Phase 2): additive only ----------------------------
    // paragraph/heading `styleId` (rendered as data-style; null = Body, or Chapter Title for H1,
    // Subheading for H2/H3), data-break-before decorations, setBlockStyle / clearDirectFormatting,
    // Enter chaining, Mod-Alt-0 Body, Mod-Alt-1 Chapter Title, Mod-\ clear direct formatting.
    BlockStyles,
    // --- end styles -----------------------------------------------------------------------
  ]
}
