import type { MarkupView } from '@/shared/track-changes'

/** Control identities and copy (the tooltips registry and the menus derive from these). */
export const TRACK_CHANGES_CONTROLS = {
  track: {
    id: 'review.track',
    label: 'Track Changes',
    shortcut: 'Mod-Shift-e',
    description: 'Record insertions, deletions and formatting with your name and the date. Saved with the project.',
  },
  markup: {
    id: 'review.markup',
    label: 'Markup',
    description: 'How tracked changes show on the pages: all markup, a change bar, the final text or the original.',
  },
  prevChange: {
    id: 'review.change.prev',
    label: 'Previous Change',
    shortcut: 'Mod-Alt-ArrowUp',
    description: 'Select the tracked change before the cursor and turn to its page.',
  },
  nextChange: {
    id: 'review.change.next',
    label: 'Next Change',
    shortcut: 'Mod-Alt-ArrowDown',
    description: 'Select the tracked change after the cursor and turn to its page.',
  },
  showChange: {
    id: 'review.change.show',
    label: 'Show Change Details',
    shortcut: 'Alt-Enter',
    description: 'Show who made the change at the cursor and when, with buttons to accept or reject it.',
  },
  accept: {
    id: 'review.accept',
    label: 'Accept Change',
    description: 'Keep the change at the cursor, or every change in the selection.',
  },
  acceptNext: {
    id: 'review.acceptNext',
    label: 'Accept and Move to Next',
    shortcut: 'Mod-Alt-a',
    description: 'Keep the change at the cursor, then select the next change.',
  },
  acceptAll: {
    id: 'review.acceptAll',
    label: 'Accept All Changes',
    description: 'Keep every tracked change in the book. Asks first when there are many.',
  },
  reject: {
    id: 'review.reject',
    label: 'Reject Change',
    description: 'Undo the change at the cursor, or every change in the selection, and remove its mark.',
  },
  rejectNext: {
    id: 'review.rejectNext',
    label: 'Reject and Move to Next',
    shortcut: 'Mod-Alt-r',
    description: 'Undo the change at the cursor, then select the next change.',
  },
  rejectAll: {
    id: 'review.rejectAll',
    label: 'Reject All Changes',
    description: 'Undo every tracked change in the book. Asks first when there are many.',
  },
  popoverAccept: {
    id: 'review.popover.accept',
    label: 'Accept',
    description: 'Keep this change and remove its mark.',
  },
  popoverReject: {
    id: 'review.popover.reject',
    label: 'Reject',
    description: 'Undo this change and remove its mark.',
  },
  changes: {
    id: 'review.changes',
    label: 'Tracked changes',
    description: 'How many tracked changes the book has. Click to go to the next one.',
  },
} as const

/** Submenus of Review (by author). */
export const BY_AUTHOR_SUBMENU = { accept: 'Accept All by Author', reject: 'Reject All by Author' } as const

export interface MarkupViewOption {
  id: string
  value: MarkupView
  label: string
  description: string
}

/** View ▸ Markup choices, in menu order. */
export const MARKUP_VIEW_OPTIONS: readonly MarkupViewOption[] = [
  {
    id: 'review.markup.all',
    value: 'all',
    label: 'All Markup',
    description: 'Show insertions underlined, deletions struck through and formatting changes marked.',
  },
  {
    id: 'review.markup.simple',
    value: 'simple',
    label: 'Simple Markup',
    description: 'Show the text as it will read, with a bar in the margin beside changed lines.',
  },
  {
    id: 'review.markup.none',
    value: 'none',
    label: 'No Markup',
    description: 'Show the text as it will read once every change is accepted.',
  },
  {
    id: 'review.markup.original',
    value: 'original',
    label: 'Original',
    description: 'Show the text as it was before the tracked changes.',
  },
]

export const markupViewLabel = (view: MarkupView): string => MARKUP_VIEW_OPTIONS.find((o) => o.value === view)?.label ?? view
