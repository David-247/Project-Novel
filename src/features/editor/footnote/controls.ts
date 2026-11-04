import type { ToolbarControlMeta } from '../toolbar/controls'

/** Controls of the footnote editor (popover); the tooltips registry adds their descriptions. */
export const FOOTNOTE_EDITOR_CONTROLS = {
  done: { id: 'footnote.done', label: 'Done', shortcut: 'Escape' },
} as const satisfies Record<string, ToolbarControlMeta>

/** Insert > Footnote (an INSERT_ITEMS entry). */
export const FOOTNOTE_INSERT = {
  id: 'footnote.insert',
  label: 'Footnote',
  shortcut: 'Mod-Alt-f',
  description: 'Add a numbered note at the cursor. Its text goes at the bottom of the page.',
} as const
