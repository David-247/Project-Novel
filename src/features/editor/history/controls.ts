import type { ToolbarControlMeta } from '../toolbar/controls'

/**
 * Stable identities, accessible names and shortcut specs for the undo / redo buttons (Tiptap
 * notation, "Mod" = Cmd on macOS, Ctrl elsewhere). The tooltips registry derives its titles and
 * shortcuts from here and adds the descriptions.
 */
export const HISTORY_CONTROLS = {
  undo: { id: 'history.undo', label: 'Undo', shortcut: 'Mod-z' },
  redo: { id: 'history.redo', label: 'Redo', shortcut: ['Mod-Shift-z', 'Mod-y'] },
} as const satisfies Record<string, ToolbarControlMeta>
