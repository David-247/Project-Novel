// Public interface of the "editor" slice. Other slices may import ONLY from here.
export { NovelEditor } from './NovelEditor'
export { FontFamilyPicker, Toolbar, ToolbarItem, TOOLBAR_CONTROLS } from './toolbar'
export type { FontFamilyPickerProps, ToolbarProps, ToolbarControlMeta, ToolbarControlKey } from './toolbar'
export { getDocJSON, setDocJSON, isDirty, markClean, onDocChange, getEditor } from './controller'
export type { DocChangeListener } from './controller'
export { createEditorExtensions } from './extensions'
export { SYSTEM_FONT_STACK, listSystemFonts, fontFamilyCss, primaryFontFamily } from './fonts'
export type { Editor, JSONContent } from '@tiptap/core'
