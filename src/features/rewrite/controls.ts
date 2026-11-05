import { REWRITE_SHORTCUT } from './anchor'

/**
 * Stable identities, names and descriptions of the re-write controls and commands. The tooltips
 * registry derives its entries from here (same shape as COMMENT_CONTROLS).
 */
export interface RewriteControlMeta {
  id: string
  label: string
  description: string
  shortcut?: string | readonly string[]
}

export const SHOW_DIFF_SHORTCUT = 'Mod-Shift-d'
export const FLIP_SHORTCUT = 'Mod-Alt-k'
export const FOCUS_LEFT_SHORTCUT = 'Mod-Alt-ArrowLeft'
export const FOCUS_RIGHT_SHORTCUT = 'Mod-Alt-ArrowRight'

export const REWRITE_CONTROLS = {
  open: {
    id: 'rewrite.open',
    label: 'Re-write Passage…',
    description: 'Write a new version of the selected paragraphs beside the original, then compare them.',
    shortcut: REWRITE_SHORTCUT,
  },
  list: { id: 'rewrite.list', label: 'Re-writes…', description: 'See every re-write in progress and open one.' },
  next: { id: 'rewrite.next', label: 'Next Re-write', description: 'Open the next passage you are re-writing.' },
  prev: { id: 'rewrite.prev', label: 'Previous Re-write', description: 'Open the passage you are re-writing before this one.' },
  showDiff: {
    id: 'rewrite.showDiff',
    label: 'Show Differences',
    description: 'Highlight the words removed from the original and the words added in the version.',
    shortcut: SHOW_DIFF_SHORTCUT,
  },
  flip: {
    id: 'rewrite.flip',
    label: 'Flip Pages',
    description: 'Swap the pages: put the version on the left and the original on the right, or back.',
    shortcut: FLIP_SHORTCUT,
  },
  focusLeft: {
    id: 'rewrite.focusLeft',
    label: 'Go to Left Page',
    description: 'Move the keyboard focus to the left page of the re-write.',
    shortcut: FOCUS_LEFT_SHORTCUT,
  },
  focusRight: {
    id: 'rewrite.focusRight',
    label: 'Go to Right Page',
    description: 'Move the keyboard focus to the right page of the re-write.',
    shortcut: FOCUS_RIGHT_SHORTCUT,
  },
  newVersion: {
    id: 'rewrite.newVersion',
    label: 'New Version',
    description: 'Start another version of the passage, as a copy of the one you are looking at.',
  },
  close: {
    id: 'rewrite.close',
    label: 'Close Re-write',
    description: 'Go back to the manuscript. Your versions are kept, and the passage stays locked.',
  },
  /** The view's own Close button: the same action, plus Escape (handled in the view). */
  closeButton: {
    id: 'rewrite.closeButton',
    label: 'Close',
    description: 'Go back to the manuscript. Your versions are kept, and the passage stays locked.',
    shortcut: 'Escape',
  },
  versionTab: {
    id: 'rewrite.versionTab',
    label: 'Version',
    description: 'Show this version on the revised page. Arrow keys move between versions.',
  },
  rename: { id: 'rewrite.rename', label: 'Rename version', description: 'Give this version a name of your own.' },
  renameField: {
    id: 'rewrite.renameField',
    label: 'Version name',
    description: 'Type a name for the version. Enter keeps it, Escape cancels.',
  },
  showOriginal: { id: 'rewrite.showOriginal', label: 'Original', description: 'Show the original passage.' },
  showRevised: { id: 'rewrite.showRevised', label: 'Revised', description: 'Show the version you are writing.' },
  compareCurrent: {
    id: 'rewrite.compareCurrent',
    label: 'Show current text',
    description: 'Show the passage as it is in the manuscript now, instead of the copy made when the re-write began.',
  },
  noticeOpen: { id: 'rewrite.noticeOpen', label: 'Open re-write', description: 'Open the re-write of this passage beside its original.' },
  noticeDismiss: { id: 'rewrite.noticeDismiss', label: 'Dismiss', description: 'Hide this message.' },
  listItem: { id: 'rewrite.listItem', label: 'Open', description: 'Open this re-write.' },
  listClose: { id: 'rewrite.listClose', label: 'Close', description: 'Close the list of re-writes.', shortcut: 'Escape' },
} as const satisfies Record<string, RewriteControlMeta>

export type RewriteControlKey = keyof typeof REWRITE_CONTROLS
