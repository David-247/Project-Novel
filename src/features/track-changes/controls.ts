import type { MarkupView } from '@/shared/track-changes'

/** Control identities and copy (the tooltips registry and the menus derive from these). */
export const TRACK_CHANGES_CONTROLS = {
  track: {
    id: 'review.track',
    label: 'Track Changes',
    shortcut: 'Mod-Shift-e',
    description: 'Record every insertion, deletion and formatting change with your name and the date. Saved with the project.',
  },
  markup: {
    id: 'review.markup',
    label: 'Markup',
    description: 'Choose how tracked changes are shown on the pages: all of them, a change bar, the final text, or the original.',
  },
} as const

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
