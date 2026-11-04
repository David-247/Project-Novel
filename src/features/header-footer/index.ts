// Public interface of the "header-footer" slice (running heads, footers and page numbers).
// Other slices import ONLY from here.
//
// - <HeaderFooter />: render once in the app. Registers the header / footer page slots with the
//   pagination slice (the text is drawn in the margins, never in the document) and hosts the
//   "Headers & page numbers" and "Book details" dialogs. Double-clicking a header or footer opens
//   the first.
// - <HeaderFooterButton />: toolbar button (data-control-id `book.headerFooter`), the keyboard route
//   to the same dialog. Wrap in the editor's ToolbarItem to join the toolbar's roving focus.
// - openHeaderFooterDialog(): the same, for commands.
// - HEADER_FOOTER_CONTROLS: control ids and names (the tooltips registry derives from them).
// The settings shape and what each page shows live in @/shared/book (`resolveHeaderFooter`).
export { HeaderFooter } from './HeaderFooter'
export { HeaderFooterButton } from './HeaderFooterButton'
export type { HeaderFooterButtonProps } from './HeaderFooterButton'
export { openHeaderFooterDialog, closeHeaderFooterDialog } from './dialog-state'
export { HEADER_FOOTER_CONTROLS } from './controls'
export type { HeaderFooterControlMeta, HeaderFooterControlKey } from './controls'
