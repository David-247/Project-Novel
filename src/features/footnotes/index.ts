// Public interface of the "footnotes" slice (docs/pagination.md, "Footnotes"). Other slices import
// ONLY from here.
//
// The footnote node, its numbering and the footnote editor live in the editor slice (schema). This
// slice puts footnotes on pages: a bottom reservation per page (the pagination slice's API), the
// footnote area drawn in the 'reserved' page slot, and the Footnote options dialog.
// - useFootnotePagination(): mount once in the composition root (installFootnotePagination() is the
//   non-React form; returns uninstall).
// - FootnoteOptionsButton: toolbar button `footnote.options` opening the dialog (wrap in ToolbarItem).
// - FOOTNOTE_OPTION_CONTROLS: control ids + copy, for the tooltips registry.
// - footnoteAreaHeights() / footnotePlacement(): the published areas (diagnostics, e2e).
export { useFootnotePagination, installFootnotePagination } from './integration'
export { FootnoteOptionsButton, FootnoteOptionsDialog, openFootnoteOptions } from './FootnoteOptions'
// Format > Footnote Options… (shared command registry). Returns unregister.
export { registerFootnoteCommands } from './commands'
export type { FootnoteOptionsButtonProps } from './FootnoteOptions'
export { FOOTNOTE_OPTION_CONTROLS } from './controls'
export type { FootnoteControlMeta } from './controls'
export { footnoteAreaHeights, footnotePlacement } from './reservation'
