/**
 * Tooltip copy for every interactive control, keyed by `data-control-id`. THE single place to edit
 * what a tooltip says.
 *
 * Titles and shortcuts are not retyped here: for editor controls they come from the editor slice's
 * public control metadata (TOOLBAR_CONTROLS / HISTORY_CONTROLS / FIND_CONTROLS), which also gives the
 * controls their accessible names, so name, tooltip title and shortcut can never drift apart. This
 * file adds the one-line descriptions. Controls whose slices keep no control metadata (project
 * file actions, crash-recovery controls, dialog close) carry their full copy here.
 *
 * Shortcut specs use Tiptap notation ("Mod" = Cmd on macOS, Ctrl elsewhere) and are rendered per
 * platform by the shared Tooltip.
 */
import { FIND_CONTROLS, FOOTNOTE_EDITOR_CONTROLS, HISTORY_CONTROLS, INSERT_CONTROLS, STYLE_DIALOG_CONTROLS, TOOLBAR_CONTROLS } from '@/features/editor'
import { FOOTNOTE_OPTION_CONTROLS } from '@/features/footnotes'
import type { ToolbarControlMeta } from '@/features/editor'
import { PAGINATION_CONTROLS } from '@/features/pagination'
import { SURFACE_CONTROLS } from '@/shared/theme'
import { TRIM_SIZES } from '@/shared/book'
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
  stylePicker: 'Style of the current paragraph. Pick one to apply it. The shortcuts apply Body and Chapter Title.',
  styleEdit: "Change how the current paragraph's style looks, everywhere in the manuscript.",
  styleManage: 'See every style in the book, and create, duplicate, rename or delete your own.',
  clearFormatting: 'Remove formatting applied by hand to the paragraph, so it looks exactly like its style.',
}

const STYLE_DIALOG_DESCRIPTIONS: Record<keyof typeof STYLE_DIALOG_CONTROLS, string> = {
  name: 'The name shown in the style list and the picker.',
  kind: 'Chapter heading or paragraph style. Locked while paragraphs use the style.',
  basedOn: 'Settings you leave empty come from this style, and follow it when it changes.',
  nextStyle: 'Style of the new paragraph when you press Enter at the end of this one.',
  fontFamily: 'Typeface name, for example Garamond. Leave empty to use the manuscript font.',
  fontSize: 'Text size in points. Leave empty to inherit it.',
  fontWeight: 'How heavy the letters are, from light to bold.',
  italic: 'Upright or italic letters.',
  textTransform: 'Show the text in capitals, small capitals or another case, without retyping it.',
  letterSpacing: 'Extra space between letters, in ems. Small values like 0.05 go a long way.',
  align: 'How lines line up: left, centered, right or justified.',
  lineHeight: 'Distance between lines as a multiple of the text size, for example 1.5.',
  spaceBefore: 'Space above the paragraph, in points.',
  spaceAfter: 'Space below the paragraph, in points.',
  firstLineIndent: 'How far the first line is pushed in, in ems.',
  indentLeft: 'Space between the left margin and the whole paragraph, in ems.',
  indentRight: 'Space between the whole paragraph and the right margin, in ems.',
  breakBefore: 'Start a new page, or a new right-hand page, before each paragraph in this style.',
  modifyReset: 'Put this built-in style back the way it came.',
  modifyCancel: 'Close without changing the style.',
  modifySave: 'Apply the changes to every paragraph that uses this style.',
  manageItem: 'Select this style to modify, duplicate, rename or delete it.',
  manageNew: 'Add a style based on the selected one.',
  manageDuplicate: 'Make a copy of the selected style under a new name.',
  manageRename: 'Give the selected style a new name. Built-in styles keep their names.',
  manageRenameField: 'The new name for the style. Enter saves it.',
  manageRenameSave: 'Save the new name.',
  manageRenameCancel: 'Keep the current name.',
  manageModify: 'Open the selected style to change how it looks.',
  manageDelete: 'Remove the selected style. You confirm first; its paragraphs switch to the style it was based on.',
  manageDeleteConfirm: 'Delete the style now. Its paragraphs switch to the style it was based on.',
  manageDeleteCancel: 'Do not delete the style.',
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

/** Paper surface picker (shared/theme SurfacePicker); titles come from SURFACE_CONTROLS. */
const SURFACE_TOOLTIPS: Record<string, TooltipCopy> = {
  [SURFACE_CONTROLS.group.id]: {
    title: SURFACE_CONTROLS.group.label,
    description: 'What the page looks like: Auto, Book, White or Dark paper.',
  },
  [SURFACE_CONTROLS.auto.id]: {
    title: SURFACE_CONTROLS.auto.label,
    description: 'White paper in light mode, dark paper in dark mode. Follows your computer.',
  },
  [SURFACE_CONTROLS.book.id]: {
    title: SURFACE_CONTROLS.book.label,
    description: 'Cream paper with a shaded spine, like an open printed book.',
  },
  [SURFACE_CONTROLS.white.id]: {
    title: SURFACE_CONTROLS.white.label,
    description: 'Plain white paper on a grey desk, like a word processor.',
  },
  [SURFACE_CONTROLS.dark.id]: {
    title: SURFACE_CONTROLS.dark.label,
    description: 'Dark paper with light text, easy on the eyes at night.',
  },
}

/**
 * Project file actions. Rendered in the window (storage slice, NoProjectActions in the status bar
 * while no project is open) and mirrored by the native File menu items with the same ids
 * (src-tauri/src/storage.rs; operating-system menus cannot show web tooltips, so there the label and
 * accelerator are the hint).
 */
const FILE_TOOLTIPS: Record<string, TooltipCopy> = {
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
    description: 'Save the manuscript to its project folder now. With no project open, choose a folder.',
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
    description: 'Close without choosing. Until your next save or autosave, the status bar can reopen this.',
  },
  'recovery.reopenPrompt': {
    title: 'Backup available — Restore…',
    description: 'Show the Restore or Discard question again for the backup found when you opened.',
  },
  'recovery.reopen': {
    title: 'Reopen Project',
    description: 'Open the project that closed unexpectedly so you can recover its changes.',
  },
  'recovery.dismiss': {
    title: 'Not Now',
    description: 'Do not reopen now. The backup stays in the project and is offered when you open it.',
  },
  'recovery.reopenClose': {
    title: 'Close',
    description: 'Close without reopening. The backup stays in the project and is offered when you open it.',
  },
}

/** Book layout controls (book-settings slice): the trim size picker and one entry per catalog size. */
const BOOK_TOOLTIPS: Record<string, TooltipCopy> = {
  'book.trimSize': {
    title: 'Trim size',
    description: 'Page size of the printed book. Changing it reflows the whole manuscript.',
  },
  ...Object.fromEntries(
    TRIM_SIZES.map((t): [string, TooltipCopy] => [
      `book.trimSize.${t.id}`,
      { title: `${t.label} (${t.dimensions})`, description: `Lay the book out on ${t.dimensions} pages.` },
    ]),
  ),
}

/** Insert menu: the button, its items and the chapter-start / ornament options (editor slice INSERT_CONTROLS). */
const INSERT_TOOLTIPS: Record<string, TooltipCopy> = Object.fromEntries(
  INSERT_CONTROLS.map((c): [string, TooltipCopy] => [c.id, { title: c.label, description: c.description, shortcut: c.shortcut }]),
)

/** Footnotes: the options button and dialog (footnotes slice), the footnote editor's Done (editor slice). */
const FOOTNOTE_TOOLTIPS: Record<string, TooltipCopy> = {
  ...Object.fromEntries(
    Object.values(FOOTNOTE_OPTION_CONTROLS).map((c): [string, TooltipCopy] => [
      c.id,
      { title: c.label, description: c.description, shortcut: 'shortcut' in c ? c.shortcut : undefined },
    ]),
  ),
  ...fromMeta(FOOTNOTE_EDITOR_CONTROLS, { done: 'Finish the footnote and put the cursor back after its number in the text.' }),
}

/** Fallback for the close (X) button of a dialog that does not name its own id. */
const DIALOG_TOOLTIPS: Record<string, TooltipCopy> = {
  'dialog.close': { title: 'Close', description: 'Close this dialog.', shortcut: 'Escape' },
}

const PAGINATION_DESCRIPTIONS: Record<keyof typeof PAGINATION_CONTROLS, string> = {
  zoomOut: 'Make the pages smaller on screen. The book itself does not change.',
  zoom: 'Fit the whole spread, fit the page width, or pick a size. Only changes how the pages look on screen.',
  zoomIn: 'Make the pages larger on screen. The book itself does not change.',
  spreadView: 'Show facing pages side by side like an open book, or one page at a time.',
}

export const TOOLTIP_REGISTRY: Readonly<Record<string, TooltipCopy>> = Object.freeze({
  ...fromMeta(TOOLBAR_CONTROLS, TOOLBAR_DESCRIPTIONS),
  ...fromMeta(PAGINATION_CONTROLS, PAGINATION_DESCRIPTIONS),
  ...fromMeta(HISTORY_CONTROLS, HISTORY_DESCRIPTIONS),
  ...fromMeta(FIND_CONTROLS, FIND_DESCRIPTIONS),
  ...fromMeta(STYLE_DIALOG_CONTROLS, STYLE_DIALOG_DESCRIPTIONS),
  ...SURFACE_TOOLTIPS,
  ...FILE_TOOLTIPS,
  ...BOOK_TOOLTIPS,
  ...INSERT_TOOLTIPS,
  ...FOOTNOTE_TOOLTIPS,
  ...RECOVERY_TOOLTIPS,
  ...DIALOG_TOOLTIPS,
})

/** Lookup for `<TooltipProvider lookup={getTooltipCopy}>`. */
export function getTooltipCopy(controlId: string): TooltipCopy | undefined {
  return Object.prototype.hasOwnProperty.call(TOOLTIP_REGISTRY, controlId) ? TOOLTIP_REGISTRY[controlId] : undefined
}
