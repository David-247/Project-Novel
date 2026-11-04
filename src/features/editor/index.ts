// Public interface of the "editor" slice. Other slices may import ONLY from here.
//
// Document API (for storage / autosave):
// - getDocJSON(): current doc JSON (O(n), call on save). After unmount it returns the last snapshot.
// - setDocJSON(doc): load a doc; resets undo history, clears dirty, does not fire onDocChange.
//   Throws (state untouched) if doc does not fit the schema, also when called before mount.
// - isDirty(), onDocChange(cb) -> unsubscribe (fires after each user edit).
// - getDocVersion(): increments on every edit and load.
// - markClean(version?): race-safe save pattern:
//     const v = getDocVersion(); const doc = getDocJSON(); await save(doc); markClean(v)
//   Dirty is cleared only if no edit happened since `v`; markClean() with no argument always clears.
// - markDirty(): flag the current content as unsaved (bumps the version, no onDocChange), e.g.
//   after restoring crash-recovery data.
export { NovelEditor } from './NovelEditor'
export type { NovelEditorProps } from './NovelEditor'
// The mounted editor (re-renders when it mounts/unmounts, not per transaction), for hosts such as pagination.
export { useMountedEditor } from './use-mounted-editor'
export { FontFamilyPicker, Toolbar, ToolbarItem, TOOLBAR_CONTROLS } from './toolbar'
export type { FontFamilyPickerProps, ToolbarProps, ToolbarControlMeta, ToolbarControlKey } from './toolbar'
export {
  getDocJSON,
  setDocJSON,
  isDirty,
  markClean,
  markDirty,
  getDocVersion,
  onDocChange,
  getEditor,
} from './controller'
export type { DocChangeListener } from './controller'
export { createEditorExtensions } from './extensions'
export { SYSTEM_FONT_STACK, listSystemFonts, fontFamilyCss, primaryFontFamily } from './fonts'
// Find & replace + history (task 4)
export { FindReplacePanel } from './find/FindReplacePanel'
// Pagination: finish layout work before the find panel scrolls a match into view.
export { setFindRevealHook } from './find/engine'
export type { FindReplacePanelProps } from './find/FindReplacePanel'
export { FindButton } from './find/FindButton'
export type { FindButtonProps } from './find/FindButton'
export { HistoryButtons } from './history/HistoryButtons'
export type { HistoryButtonsProps } from './history/HistoryButtons'
export { HISTORY_DEPTH } from './extensions'
// Control identities + names + shortcut specs (the tooltips registry derives from these)
export { FIND_CONTROLS } from './find/controls'
export { HISTORY_CONTROLS } from './history/controls'
export type { Editor, JSONContent } from '@tiptap/core'
// Paragraph and chapter styles (Phase 2). Definitions: book.styles (shape, built-ins and
// registerBuiltInStyle live in @/shared/book). Blocks carry `styleId` and render
// `data-style="<id>"` plus `data-break-before="page|recto"` (pagination contract).
export { STYLE_DIALOG_CONTROLS } from './styles/controls'
export { BookStyleSheet, STYLE_SCOPE } from './styles/BookStyleSheet'
export { getResolvedStyles, useResolvedStyles } from './styles/resolved'
export { defaultStyleIdFor, effectiveStyleId } from './styles/block-styles'
export {
  countStyleUses,
  createStyle,
  deleteStyle,
  duplicateStyle,
  getStyleDefinition,
  renameStyle,
  resetStyle,
  saveStyle,
} from './styles/actions'
// Chapter, page and scene breaks (Phase 2).
// getChapters(doc, styles?) -> [{ index, title, from, to }] from chapter title blocks (see below; 0-based;
// content before the first chapter is front matter, chapter index FRONT_MATTER_INDEX = -1;
// chapterIndexAt(chapters, pos)). A chapter number block directly before a title joins its chapter.
// Page breaks: the pageBreak atom makes the FOLLOWING block render data-break-before="page" (or "recto"
// when that block's style says so). See docs/pagination.md.
// Insert menu: add an item with one entry in INSERT_ITEMS (breaks/controls.ts).
// A chapter opens at a block whose style is a chapter title style (Chapter Title, or a level-1 chapter
// style based on it, e.g. its duplicate: chapterRoles in @/shared/book), so getChapters follows book.styles.
export { getChapters, chapterIndexAt, FRONT_MATTER_INDEX } from './breaks/chapters'
// A block's text without the text of its footnotes (chapter titles, previews): use instead of textContent.
export { blockPlainText } from './block-text'
// Track changes: blockPlainText(node, { markupView }) leaves out what that markup view hides.
export type { BlockPlainTextOptions } from './block-text'
export type { Chapter } from './breaks/chapters'
export { getChaptersStartOn, setChaptersStartOn } from './breaks/chapter-start'
export type { ChaptersStartOn } from './breaks/chapter-start'
export { InsertMenu } from './breaks/InsertMenu'
export type { InsertMenuProps } from './breaks/InsertMenu'
export { INSERT_CONTROLS, INSERT_ITEMS, INSERT_MENU_CONTROL } from './breaks/controls'
export type { InsertControlMeta, InsertItem } from './breaks/controls'
export { mapPastedHtml } from './breaks/paste'
export { SCENE_ORNAMENTS } from './breaks/nodes'
// Footnotes (Phase 2). Node `footnote` (inline atom; its content is the note text). Numbers are
// derived: getFootnotes() lists the references in order with their labels; onFootnotesChange(cb)
// fires after an update that changed the list. FOOTNOTE_NODE is the node type name.
export { FOOTNOTE_NODE, onFootnotesChange, collectFootnotes } from './footnote/numbering'
export type { FootnoteRef, FootnotesListener } from './footnote/numbering'
export { getFootnotes } from './footnote/api'
export { FOOTNOTE_EDITOR_CONTROLS } from './footnote/controls'
