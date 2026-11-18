/**
 * Stable identities, names and descriptions of the navigation pane's controls. The tooltips registry
 * derives its entries from here (the toggle's copy comes from its registry command).
 */
export interface OutlineControlMeta {
  id: string
  label: string
  description: string
  shortcut?: string
}

/**
 * View ▸ Navigation Pane. Word has no default key for it (its Ctrl+F opens the pane on Search; here
 * Ctrl/Cmd+F is Find): Ctrl/Cmd+Shift+O ("outline") is free on both platforms.
 */
export const NAVIGATION_PANE_SHORTCUT = 'Mod-Shift-o'

export const OUTLINE_CONTROLS = {
  toggle: {
    id: 'view.navigationPane',
    label: 'Navigation Pane',
    description: 'Show or hide the chapters and subheadings at the left, with word and page counts, to jump to one.',
    shortcut: NAVIGATION_PANE_SHORTCUT,
  },
  close: { id: 'outline.close', label: 'Close navigation pane', description: 'Hide the navigation pane. View ▸ Navigation Pane shows it again.' },
  item: {
    id: 'outline.item',
    label: 'Heading',
    description: 'Go to this part of the manuscript. Arrows move through the list; Left and Right fold a chapter.',
  },
  fold: {
    id: 'outline.fold',
    label: 'Fold chapter',
    description: "Hide or show this chapter's subheadings. Left and Right on the row do the same.",
  },
  resize: {
    id: 'outline.resize',
    label: 'Resize navigation pane',
    description: 'Drag, or use the Left and Right arrow keys, to make the pane narrower or wider.',
  },
} as const satisfies Record<string, OutlineControlMeta>

export type OutlineControlKey = keyof typeof OUTLINE_CONTROLS
