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
export { useMountedEditor, useActiveEditor } from './use-mounted-editor'
export {
  FontFamilyPicker,
  Toolbar,
  ToolbarItem,
  TOOLBAR_CONTROLS,
  FontControls,
  TextStyleControls,
  ListControls,
  AlignmentControls,
  SpacingControls,
  StylesControls,
} from './toolbar'
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
  subscribeEditor,
  getActiveEditor,
  setActiveEditorSource,
  activeEditorChanged,
} from './controller'
export type { DocChangeListener } from './controller'
export { createEditorExtensions } from './extensions'
export type { EditorExtensionOptions } from './extensions'
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
export { defaultStyleIdFor, effectiveStyleId, restyleBlock } from './styles/block-styles'
export {
  countStyleUses,
  createStyle,
  deleteStyle,
  duplicateStyle,
  getStyleDefinition,
  onStyleDeleted,
  renameStyle,
  resetStyle,
  saveStyle,
} from './styles/actions'
export type { StyleRemap } from './styles/actions'
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
// Menu commands (Phase 3, shared command registry): Edit (undo, clipboard, find), Insert and Format.
// registerEditorCommands() -> unregister; call once from the composition root.
export { registerEditorCommands } from './commands'
export { openModifyStyle, setManagingStyles } from './styles/dialog-state'
export { FOOTNOTE_EDITOR_CONTROLS } from './footnote/controls'
// Word count (Phase 4, docs/word-count.md). The mounted manuscript's live counts are published to the
// store's `wordCount` (document, selection, front matter, per chapter; body and footnotes apart, and
// `total` per "Include footnotes"), off the typing path. countManuscript / countRange count any
// document the same way (text with every tracked change accepted; cached per top-level block).
// <WordCountIndicator> goes in the status bar, <WordCountDialog> once in the app (portal); lines come
// from setWordCountLineSource (the composition root wires the pagination slice's countLines).
export { countManuscript, countRange } from './word-count/count'
export type { BodyAndNotes, ManuscriptCounts } from './word-count/count'
export { flushWordCount, WORD_COUNT_THROTTLE_MS } from './word-count/publisher'
export { WordCountDialog, WordCountIndicator, openWordCount, setWordCountLineSource, wordCountText } from './word-count/WordCount'
export { WORD_COUNT_CONTROLS } from './word-count/controls'
export type { WordCountControlMeta } from './word-count/controls'
// The manuscript's context menu (Phase 5): right-click, Shift+F10, the Menu key. Slices add items with
// registerContextMenuItems(provider) -> unregister; a provider gets { editor, pos, selection } when the
// menu opens and returns MenuItem[] (id = data-control-id with a tooltips registry entry; order ranges
// in context-menu/registry.ts: suggestions, proofing, other actions, clipboard). openEditorContextMenu
// opens it from code (tests, other entry points).
export { registerContextMenuItems } from './context-menu/registry'
export type { ContextMenuContext, ContextMenuProvider, MenuItem } from './context-menu/registry'
export { openEditorContextMenu, isContextMenuKey } from './context-menu/opener'
export type { ContextMenuRequest } from './context-menu/opener'
