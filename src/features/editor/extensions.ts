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
import { BookBreaks } from './breaks/nodes'
import { Footnotes } from './footnote/node'
import { CommentsExtension } from '@/features/comments'
import { TrackChanges } from '@/features/track-changes'
import { RewriteAnchor } from '@/features/rewrite'

/**
 * Phase 1 base schema.
 * Nodes: doc, paragraph, heading (1-3), text, hardBreak, bulletList, orderedList, listItem.
 * Marks: bold, italic, underline, textStyle (carries fontFamily).
 * Plus undo/redo history (Mod-z / Mod-Shift-z / Mod-y), find highlighting and the FontFamily attribute.
 */
/** Undo history depth: effectively unlimited (see the task 4 block below). */
export const HISTORY_DEPTH = Number.MAX_SAFE_INTEGER

export interface EditorExtensionOptions {
  /**
   * The same schema for another view (the re-write comparison pages): nothing that belongs to the
   * manuscript's one view runs there. No comment thread plugin, no tracked-change recording, no
   * footnote editor or footnote-area notifications, no re-write lock.
   */
  detached?: boolean
}

export function createEditorExtensions({ detached = false }: EditorExtensionOptions = {}): Extensions {
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
    // textStyle.fontSize; paragraph/heading textAlign (Mod-Shift-l, Mod-e, Mod-Shift-r, Mod-Shift-j);
    // paragraph/heading lineHeight, paragraphSpacing, indent (Mod-] / Mod-[).
    FontSize,
    // Center is Mod-e (as in Word): Mod-Shift-e is Track Changes (Phase 3).
    TextAlign.extend({
      addKeyboardShortcuts() {
        return {
          'Mod-Shift-l': () => this.editor.commands.setTextAlign('left'),
          'Mod-e': () => this.editor.commands.setTextAlign('center'),
          'Mod-Shift-r': () => this.editor.commands.setTextAlign('right'),
          'Mod-Shift-j': () => this.editor.commands.setTextAlign('justify'),
        }
      },
    }).configure({ types: [...BLOCK_FORMAT_TYPES], alignments: ['left', 'center', 'right', 'justify'] }),
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
    // Detached views: the highlights only; Mod-f / Escape belong to the manuscript.
    detached ? FindHighlight.extend({ addKeyboardShortcuts: () => ({}) }) : FindHighlight,
    // --- end task 4 -----------------------------------------------------------------------

    // --- Paragraph and chapter styles (Phase 2): additive only ----------------------------
    // paragraph/heading `styleId` (rendered as data-style; null = Body, or Chapter Title for H1,
    // Subheading for H2/H3), data-break-before decorations, setBlockStyle / clearDirectFormatting,
    // Enter chaining, Mod-Alt-0 Body, Mod-Alt-1 Chapter Title, Mod-\ clear direct formatting.
    BlockStyles,
    // Chapter, page and scene breaks: pageBreak / sceneBreak atoms, New chapter, Mod-Enter,
    // Mod-Shift-Enter, Mod-Alt-Enter, the *** / ### input rules and the page-break / <hr> paste mapping.
    BookBreaks,
    // --- end styles -----------------------------------------------------------------------

    // --- Footnotes (Phase 2): additive only. The inline `footnote` atom (its content is the note
    // text), derived numbering (book.footnotes), Insert Footnote (Mod-Alt-f), Enter edits a selected
    // reference.
    detached ? Footnotes.configure({ detached: true }) : Footnotes,

    // --- Comments (Phase 3): additive only. The inline `comment` mark (attr id; overlaps other
    // comments and every other mark), the thread plugin (threads change through undoable steps) and
    // Mod-Alt-m (New Comment).
    detached ? CommentsExtension.extend({ addProseMirrorPlugins: () => [], addKeyboardShortcuts: () => ({}) }) : CommentsExtension,
    // --- Track changes (Phase 3): additive only. insertion / deletion / formatChange marks, the
    // trackedInsert / trackedDelete / trackedStyleChange block attrs, the recorder (dispatch hook),
    // Mod-Shift-e and the markup view decorations (docs/track-changes.md).
    detached ? TrackChanges.configure({ isEnabled: () => false, detached: true }) : TrackChanges,
    // --- Re-write (Phase 3): additive only. The `rewriteId` block attribute (passage anchor), the
    // read-only lock on passages in re-write and their side bar, Mod-Alt-w (Re-write Passage…).
    RewriteAnchor.configure({ detached }),
  ]
}
