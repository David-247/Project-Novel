import type { Platform, ShortcutSpec } from '@/shared/ui'

/**
 * Keys that are not registry commands but that the Keyboard Shortcuts sheet lists too (Help >
 * Keyboard Shortcuts, "Navigation"): they are handled where they act. Keep in step with:
 *  - PageUp / PageDown, Mod-Home / Mod-End: src/features/pagination/PaginatedView.tsx;
 *  - Home / End on a page-turn control: src/features/pagination/TurnControls.tsx;
 *  - Escape in the ribbon: src/features/ribbon/Ribbon.tsx;
 *  - Alt and F10 for the menu bar (not on macOS: the native menu bar): src/features/menu/MenuBar.tsx;
 *  - Shift+F10 and the Menu key for the manuscript's context menu: src/features/editor/context-menu/opener.ts.
 */
export interface ExtraShortcut {
  id: string
  label: string
  description: string
  keys: (platform: Platform) => ShortcutSpec[]
}

export const EXTRA_SHORTCUTS: readonly ExtraShortcut[] = [
  {
    id: 'nav.pageUpDown',
    label: 'Previous / Next Pages',
    description: 'Turn to the previous or next pages (Book mode) and put the caret at their start.',
    keys: () => ['PageUp', 'PageDown'],
  },
  {
    id: 'nav.docEdges',
    label: 'Start / End of the Book',
    description: 'Put the caret at the start or the end of the manuscript.',
    keys: (p) => (p === 'mac' ? ['Mod-ArrowUp', 'Mod-ArrowDown'] : ['Mod-Home', 'Mod-End']),
  },
  {
    id: 'nav.turnEdges',
    label: 'First / Last Pages',
    description: 'On a page-turn button: turn to the first or the last pages of the book.',
    keys: () => ['Home', 'End'],
  },
  {
    id: 'nav.ribbonEscape',
    label: 'Back to the Manuscript',
    description: 'From the ribbon: return to the manuscript, with its selection.',
    keys: () => ['Escape'],
  },
  {
    id: 'nav.menuBar',
    label: 'Menu Bar',
    description: 'Move to the menu bar (Alt with a menu’s underlined letter opens that menu).',
    keys: (p) => (p === 'mac' ? [] : ['Alt', 'F10']),
  },
  {
    id: 'nav.contextMenu',
    label: 'Context Menu',
    description: 'In the manuscript: open the menu of spelling suggestions and editing actions at the cursor.',
    keys: () => ['Shift-F10', 'ContextMenu'],
  },
]
