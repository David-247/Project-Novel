/** Control identities of the Footnote options button and dialog (copy: the tooltips registry). */
export interface FootnoteControlMeta {
  id: string
  label: string
  description: string
  shortcut?: string
}

export const FOOTNOTE_OPTION_CONTROLS = {
  open: {
    id: 'footnote.options',
    label: 'Footnotes',
    description: 'Choose how footnotes are numbered, and whether a rule sets them off from the text.',
  },
  numbering: {
    id: 'footnote.options.numbering',
    label: 'Numbering',
    description: 'Number footnotes through the whole book, or start again at 1 in each chapter.',
  },
  format: {
    id: 'footnote.options.format',
    label: 'Number format',
    description: 'Mark footnotes with numbers, or with the symbols *, †, ‡ and so on.',
  },
  separator: {
    id: 'footnote.options.separator',
    label: 'Separator line above footnotes',
    description: 'Draw a short rule between the text and the footnotes of each page.',
  },
  done: { id: 'footnote.options.done', label: 'Done', description: 'Close the footnote options. Changes are already applied.' },
  close: { id: 'footnote.options.close', label: 'Close', description: 'Close the footnote options.', shortcut: 'Escape' },
} as const satisfies Record<string, FootnoteControlMeta>
