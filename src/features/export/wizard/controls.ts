/**
 * Identities, names, one-line descriptions and Alt shortcuts of the export wizard's controls (and the
 * status bar's export notice). The tooltips registry takes its copy from here; `mnemonic` is the
 * letter Alt+<letter> reaches in the dialog (Word's underlined access keys), shown underlined.
 */
export interface ExportControlMeta {
  id: string
  label: string
  description: string
  /** The Alt access key (a letter or digit). */
  mnemonic?: string
  shortcut?: string
}

const alt = (k: string) => ({ mnemonic: k, shortcut: `Alt-${k}` })

export const EXPORT_COMMAND_IDS = { manuscript: 'export.manuscript', again: 'export.again' } as const

export const EXPORT_WIZARD_CONTROLS = {
  close: { id: 'export.close', label: 'Close', description: 'Close the export wizard. Your choices are kept with the project.', shortcut: 'Escape' },
  stepTitle: { id: 'export.step.title', label: 'Title page', description: 'Title, by-line, contact details, genre and the word count on the title page.', ...alt('1') },
  stepFormat: { id: 'export.step.format', label: 'Formatting', description: 'Preset, paper, font, scene-break and end markers, with a preview of the pages.', ...alt('2') },
  stepChecks: { id: 'export.step.checks', label: 'Checks', description: 'What agents and editors expect, checked against this manuscript, with a way to fix each problem.', ...alt('3') },
  stepExport: { id: 'export.step.export', label: 'Export', description: 'Choose DOCX, PDF or both and where to save them, then export.', ...alt('4') },
  back: { id: 'export.back', label: 'Back', description: 'Go to the previous step.', ...alt('b') },
  next: { id: 'export.next', label: 'Next', description: 'Go to the next step.', ...alt('n') },
  cancel: { id: 'export.cancel', label: 'Cancel', description: 'Close the wizard without exporting. Your choices are kept with the project.', shortcut: 'Escape' },
  finish: { id: 'export.finish', label: 'Close', description: 'Close the wizard. Your choices are kept with the project.', shortcut: 'Escape' },
  // ---- 1. Title page
  title: { id: 'export.title', label: 'Title', description: 'The title, centred on the title page and shortened in the header. Saved as the project title.', ...alt('t') },
  legalName: { id: 'export.legalName', label: 'Legal name', description: 'Your legal name, first in the contact block (agents need it for contracts).', ...alt('l') },
  penName: { id: 'export.penName', label: 'Pen name', description: 'The name on the by-line and in the header, if it is not your legal name. Empty uses your legal name.', ...alt('p') },
  overrideContact: { id: 'export.overrideContact', label: 'Use other details for this project', description: 'Off: your author profile in Settings (every project). On: changes apply to this project only.', ...alt('o') },
  address: { id: 'export.address', label: 'Address', description: 'Your postal address for the contact block, one line per line.', ...alt('d') },
  phone: { id: 'export.phone', label: 'Phone', description: 'Your phone number for the contact block.', ...alt('h') },
  email: { id: 'export.email', label: 'Email', description: 'Your email address for the contact block.', ...alt('m') },
  agent: { id: 'export.agent', label: 'Agent', description: 'Your agent or agency (optional), one line per line.', ...alt('a') },
  showAgent: { id: 'export.showAgent', label: 'Show the agent on the title page', description: 'Print the agent under your contact details on the title page.', ...alt('s') },
  genre: { id: 'export.genre', label: 'Genre', description: 'Optional. The length check compares the word count with the usual range for this genre.', ...alt('g') },
  debut: { id: 'export.debut', label: 'First novel (debut range)', description: 'Compare with the range agents suggest for a first novel, where the sources give one.', ...alt('f') },
  rounding: { id: 'export.rounding', label: 'Word count rounding', description: 'How the title page rounds the word count. Automatic: nearest 100, or 500 from 20,000 words.', ...alt('r') },
  // ---- 2. Formatting
  presetStandard: { id: 'export.preset.standard', label: 'Standard (modern)', description: 'Times New Roman 12 pt, italics, one space after a sentence. What most agents expect today.', ...alt('s') },
  presetClassic: { id: 'export.preset.classic', label: 'Classic (Courier)', description: 'Courier New 12 pt, underline for italics, two spaces after a sentence, for markets that ask for it.', ...alt('c') },
  paper: { id: 'export.paper', label: 'Paper', description: 'Letter (the Americas) or A4 (everywhere else).', ...alt('p') },
  font: { id: 'export.font', label: 'Font', description: 'The font the Word file names. The PDF is set in Times New Roman or Courier New, or a free font with the same widths where they are not installed.', ...alt('f') },
  sceneBreak: { id: 'export.sceneBreak', label: 'Scene-break marker', description: 'Printed centred on its own line between scenes. "#" is the standard.', ...alt('k') },
  endMarker: { id: 'export.endMarker', label: 'End marker', description: 'Optional END or THE END after the last line.', ...alt('d') },
  // ---- 3. Checks
  checkFix: { id: 'export.check.fix', label: 'Fix', description: 'Go to the field this check is about.' },
  checkReviewChanges: { id: 'export.check.reviewChanges', label: 'Review changes', description: 'Close the wizard and go to the next pending tracked change.' },
  checkShowComments: { id: 'export.check.showComments', label: 'Show comments', description: 'Close the wizard and show the comments beside the pages.' },
  checkOpenRewrite: { id: 'export.check.openRewrite', label: 'Open re-write', description: 'Close the wizard and open the next re-write beside its original.' },
  checkShowChapter: { id: 'export.check.showChapter', label: 'Show me', description: 'Close the wizard and put the cursor at the start of this chapter.' },
  checkShowText: { id: 'export.check.showText', label: 'Show me', description: 'Close the wizard and put the cursor there in the manuscript.' },
  checkFixSpaces: { id: 'export.check.fixSpaces', label: 'Export one space', description: 'Export two or more spaces after a full stop as one. The manuscript keeps its spaces.' },
  checkFixBlankLines: { id: 'export.check.fixBlankLines', label: 'Never read blank lines as breaks', description: 'Leave empty paragraphs out of the export; none becomes a scene break.' },
  normalizeSpaces: { id: 'export.normalizeSpaces', label: 'Export one space after a full stop', description: 'Two or more spaces after a full stop are exported as one. The manuscript keeps its spaces.', ...alt('z') },
  blankLines: { id: 'export.blankLines', label: 'Read blank lines between paragraphs as scene breaks', description: 'On: an empty paragraph between two paragraphs becomes a scene break. Off: it is left out.', ...alt('y') },
  // ---- 4. Export
  formatDocx: { id: 'export.format.docx', label: 'Word document (.docx)', description: 'Export a Word file: what most agents and publishers ask for.', ...alt('w') },
  formatPdf: { id: 'export.format.pdf', label: 'PDF (.pdf)', description: 'Export a PDF, for markets that accept one.', ...alt('p') },
  start: { id: 'export.start', label: 'Export', description: 'Choose where to save each file, then export the manuscript.', ...alt('e') },
  cancelRun: { id: 'export.cancelRun', label: 'Cancel export', description: 'Stop the export. No file is written.', ...alt('c') },
  retry: { id: 'export.retry', label: 'Retry', description: 'Export again to the same files.', ...alt('r') },
  chooseLocation: { id: 'export.chooseLocation', label: 'Choose another location', description: 'Pick other places to save the files, then export.', ...alt('l') },
  openFile: { id: 'export.openFile', label: 'Open file', description: 'Open the exported file in its program (Word, a PDF viewer).', ...alt('o') },
  showInFolder: { id: 'export.showInFolder', label: 'Show in folder', description: 'Show the exported file in its folder.', ...alt('f') },
  // ---- status bar (Export Manuscript Again)
  statusCancel: { id: 'export.status.cancel', label: 'Cancel export', description: 'Stop the export. No file is written.' },
  statusRetry: { id: 'export.status.retry', label: 'Retry', description: 'Export again to the same files.' },
  statusShow: { id: 'export.status.show', label: 'Show in folder', description: 'Show the exported file in its folder.' },
  statusDismiss: { id: 'export.status.dismiss', label: 'Dismiss', description: 'Hide this message.' },
} as const satisfies Record<string, ExportControlMeta>

export type ExportControlKey = keyof typeof EXPORT_WIZARD_CONTROLS
