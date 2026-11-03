/**
 * Tooltip copy for every interactive control, keyed by `data-control-id`. THE single place to edit
 * what a tooltip says.
 *
 * Titles and shortcuts are not retyped here: for editor controls they come from the editor slice's
 * public control metadata (TOOLBAR_CONTROLS / HISTORY_CONTROLS / FIND_CONTROLS), which also gives the
 * controls their accessible names, so name, tooltip title and shortcut can never drift apart. This
 * file adds the one-line descriptions. Controls owned by no slice in this tree (native menu, crash
 * recovery dialogs, dialog close) carry their full copy here.
 *
 * Shortcut specs use Tiptap notation ("Mod" = Cmd on macOS, Ctrl elsewhere) and are rendered per
 * platform by the shared Tooltip.
 */
import { FIND_CONTROLS, HISTORY_CONTROLS, TOOLBAR_CONTROLS } from '@/features/editor'
import type { ToolbarControlMeta } from '@/features/editor'
import type { TooltipCopy } from '@/shared/ui'

function fromMeta<K extends string>(
  controls: Record<K, ToolbarControlMeta>,
  descriptions: Record<K, string>,
): Record<string, TooltipCopy> {
  const out: Record<string, TooltipCopy> = {}
  for (const key of Object.keys(controls) as K[]) {
    const meta = controls[key]
    out[meta.id] = { title: meta.label, description: descriptions[key], shortcut: meta.shortcut }
  }
  return out
}

const TOOLBAR_DESCRIPTIONS: Record<keyof typeof TOOLBAR_CONTROLS, string> = {
  fontFamily: 'Typeface for the selected text, or for new text at the cursor.',
  fontSize: 'Text size in points for the selected text, or for new text at the cursor.',
  bold: 'Make the selected text bold, or turn bold off.',
  italic: 'Italicize the selected text, or turn italics off.',
  underline: 'Underline the selected text, or remove the underline.',
  bulletList: 'Turn the selected paragraphs into a bulleted list, or back into paragraphs.',
  orderedList: 'Turn the selected paragraphs into a numbered list, or back into paragraphs.',
  alignLeft: 'Line the paragraph up along the left edge.',
  alignCenter: 'Center each line of the paragraph.',
  alignRight: 'Line the paragraph up along the right edge.',
  alignJustify: 'Stretch lines so both edges of the paragraph are straight.',
  lineSpacing: 'Space between the lines inside a paragraph.',
  paragraphSpacing: 'Extra space added after each paragraph.',
  firstLineIndent: 'How far the first line of each paragraph is pushed in.',
  indentDecrease: 'Move the paragraph one step to the left.',
  indentIncrease: 'Move the paragraph one step to the right.',
}

const HISTORY_DESCRIPTIONS: Record<keyof typeof HISTORY_CONTROLS, string> = {
  undo: 'Take back your last change.',
  redo: 'Put back the change you just undid.',
}

const FIND_DESCRIPTIONS: Record<keyof typeof FIND_CONTROLS, string> = {
  open: 'Search the manuscript and replace words or phrases.',
  query: 'Text to look for. Enter goes to the next match, Shift+Enter to the previous one.',
  replacement: 'Text that replaces each match. Enter replaces the current match.',
  previous: 'Jump to the previous match.',
  next: 'Jump to the next match.',
  close: 'Close the panel and go back to writing.',
  replace: 'Replace the highlighted match and move to the next one.',
  replaceAll: 'Replace every match at once. One undo puts them all back.',
  caseSensitive: 'Only find matches with the same capital letters.',
  wholeWord: 'Only find whole words, not parts of longer words.',
}

/**
 * Native File menu items (Tauri menu, built in src-tauri/src/storage.rs). Operating-system menus
 * cannot show web tooltips: their labels and accelerators are the hint. This copy is kept so any
 * in-app control that later triggers the same action reuses the id and gets the same tooltip.
 */
export const NATIVE_MENU_TOOLTIPS: Record<string, TooltipCopy> = {
  'file.new_project': {
    title: 'New Project',
    description: 'Start a new project folder for a manuscript.',
    shortcut: 'Mod-Shift-n',
  },
  'file.open_project': {
    title: 'Open Project',
    description: 'Open an existing project folder.',
    shortcut: 'Mod-o',
  },
  'file.open_recent': {
    title: 'Open Recent',
    description: 'Reopen one of the projects you used lately.',
  },
  'file.save': {
    title: 'Save',
    description: 'Save the manuscript to its project folder now.',
    shortcut: 'Mod-s',
  },
}

/**
 * Crash-recovery dialogs (storage slice, RecoveryDialog). Titles match the button labels; the
 * close (X) buttons get their own ids because their accessible names differ per dialog.
 */
const RECOVERY_TOOLTIPS: Record<string, TooltipCopy> = {
  'recovery.restore': {
    title: 'Restore',
    description: 'Load the automatic backup, which is newer than your last save.',
  },
  'recovery.discard': {
    title: 'Discard Backup',
    description: 'Delete the backup and keep the last saved version.',
  },
  'recovery.decideLater': {
    title: 'Decide later',
    description: 'Close without choosing. The backup is kept and offered again next time.',
  },
  'recovery.reopen': {
    title: 'Reopen Project',
    description: 'Open the project that closed unexpectedly so you can recover its changes.',
  },
  'recovery.dismiss': {
    title: 'Not Now',
    description: 'Skip for now. The backup is kept and offered again next time.',
  },
  'recovery.reopenClose': {
    title: 'Not now',
    description: 'Close without reopening. The backup is kept and offered again next time.',
  },
}

/** Fallback for the close (X) button of a dialog that does not name its own id. */
const DIALOG_TOOLTIPS: Record<string, TooltipCopy> = {
  'dialog.close': { title: 'Close', description: 'Close this dialog.', shortcut: 'Escape' },
}

export const TOOLTIP_REGISTRY: Readonly<Record<string, TooltipCopy>> = Object.freeze({
  ...fromMeta(TOOLBAR_CONTROLS, TOOLBAR_DESCRIPTIONS),
  ...fromMeta(HISTORY_CONTROLS, HISTORY_DESCRIPTIONS),
  ...fromMeta(FIND_CONTROLS, FIND_DESCRIPTIONS),
  ...NATIVE_MENU_TOOLTIPS,
  ...RECOVERY_TOOLTIPS,
  ...DIALOG_TOOLTIPS,
})

/** Lookup for `<TooltipProvider lookup={getTooltipCopy}>`. */
export function getTooltipCopy(controlId: string): TooltipCopy | undefined {
  return Object.prototype.hasOwnProperty.call(TOOLTIP_REGISTRY, controlId) ? TOOLTIP_REGISTRY[controlId] : undefined
}
