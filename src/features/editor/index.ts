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
export { NovelEditor } from './NovelEditor'
export { FontFamilyPicker, Toolbar, ToolbarItem, TOOLBAR_CONTROLS } from './toolbar'
export type { FontFamilyPickerProps, ToolbarProps, ToolbarControlMeta, ToolbarControlKey } from './toolbar'
export {
  getDocJSON,
  setDocJSON,
  isDirty,
  markClean,
  getDocVersion,
  onDocChange,
  getEditor,
} from './controller'
export type { DocChangeListener } from './controller'
export { createEditorExtensions } from './extensions'
export { SYSTEM_FONT_STACK, listSystemFonts, fontFamilyCss, primaryFontFamily } from './fonts'
export type { Editor, JSONContent } from '@tiptap/core'
