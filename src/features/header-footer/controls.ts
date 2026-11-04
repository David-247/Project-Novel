/**
 * Stable identities and names of the header/footer controls (toolbar button and the two dialogs).
 * The tooltips registry derives titles from here and adds descriptions. Same shape as the editor
 * slice's ToolbarControlMeta.
 */
export interface HeaderFooterControlMeta {
  id: string
  label: string
  shortcut?: string | readonly string[]
}

export const HEADER_FOOTER_CONTROLS = {
  open: { id: 'book.headerFooter', label: 'Headers & page numbers' },
  verso: { id: 'book.headerFooter.verso', label: 'Left-hand pages show' },
  versoText: { id: 'book.headerFooter.versoText', label: 'Left-hand custom text' },
  recto: { id: 'book.headerFooter.recto', label: 'Right-hand pages show' },
  rectoText: { id: 'book.headerFooter.rectoText', label: 'Right-hand custom text' },
  numberPosition: { id: 'book.headerFooter.numberPosition', label: 'Page numbers' },
  numberFormat: { id: 'book.headerFooter.numberFormat', label: 'Number style' },
  numberStart: { id: 'book.headerFooter.numberStart', label: 'Starting number' },
  frontMatter: { id: 'book.headerFooter.frontMatter', label: 'Front matter numbers' },
  restart: { id: 'book.headerFooter.restart', label: 'Start numbering at the first chapter' },
  suppressHeader: { id: 'book.headerFooter.suppressHeader', label: 'No header on chapter openings' },
  suppressNumber: { id: 'book.headerFooter.suppressNumber', label: 'No page number on chapter openings' },
  suppressBlank: { id: 'book.headerFooter.suppressBlank', label: 'Nothing on blank pages' },
  details: { id: 'book.details', label: 'Book details…' },
  done: { id: 'book.headerFooter.done', label: 'Done' },
  detailsTitle: { id: 'book.details.title', label: 'Book title' },
  detailsAuthor: { id: 'book.details.author', label: 'Author' },
  detailsSave: { id: 'book.details.save', label: 'Save details' },
  detailsCancel: { id: 'book.details.cancel', label: 'Cancel' },
} as const satisfies Record<string, HeaderFooterControlMeta>

export type HeaderFooterControlKey = keyof typeof HEADER_FOOTER_CONTROLS
