import type { ToolbarControlMeta } from '../toolbar/controls'

/**
 * Stable identities, accessible names and shortcut specs for the find & replace controls
 * (Tiptap notation, "Mod" = Cmd on macOS, Ctrl elsewhere). The tooltips registry derives its
 * titles and shortcuts from here and adds the descriptions.
 */
export const FIND_CONTROLS = {
  open: { id: 'find.open', label: 'Find and replace', shortcut: 'Mod-f' },
  query: { id: 'find.query', label: 'Find' },
  replacement: { id: 'find.replacement', label: 'Replace with' },
  previous: { id: 'find.previous', label: 'Previous match', shortcut: 'Shift-Enter' },
  next: { id: 'find.next', label: 'Next match', shortcut: 'Enter' },
  close: { id: 'find.close', label: 'Close find and replace', shortcut: 'Escape' },
  replace: { id: 'find.replace', label: 'Replace' },
  replaceAll: { id: 'find.replaceAll', label: 'Replace all' },
  caseSensitive: { id: 'find.caseSensitive', label: 'Match case' },
  wholeWord: { id: 'find.wholeWord', label: 'Whole word' },
} as const satisfies Record<string, ToolbarControlMeta>

export const HISTORY_CONTROLS = {
  undo: { id: 'history.undo', label: 'Undo', shortcut: 'Mod-z' },
  redo: { id: 'history.redo', label: 'Redo', shortcut: ['Mod-Shift-z', 'Mod-y'] },
} as const satisfies Record<string, ToolbarControlMeta>
