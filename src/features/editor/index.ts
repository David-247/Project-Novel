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
export type { FindReplacePanelProps } from './find/FindReplacePanel'
export { FindButton } from './find/FindButton'
export type { FindButtonProps } from './find/FindButton'
export { HistoryButtons } from './history/HistoryButtons'
export type { HistoryButtonsProps } from './history/HistoryButtons'
export { HISTORY_DEPTH } from './extensions'
// Control identities + names + shortcut specs (the tooltips registry derives from these)
export { FIND_CONTROLS, HISTORY_CONTROLS } from './find/controls'
export type { Editor, JSONContent } from '@tiptap/core'
