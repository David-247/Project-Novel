/** Control identities of the word count (status bar, Word Count dialog); copy: the tooltips registry. */
export interface WordCountControlMeta {
  id: string
  label: string
  description: string
  shortcut?: string
}

export const WORD_COUNT_CONTROLS = {
  /** The command (Review ▸ Word Count…, the ribbon's Review ▸ Proofing button, Mod-Shift-g). */
  open: {
    id: 'review.wordCount',
    label: 'Word Count',
    description: 'See the pages, words, characters, paragraphs and lines of the book or of the selection.',
    shortcut: 'Mod-Shift-g',
  },
  /** The status bar's count: a button that opens the dialog. */
  indicator: {
    id: 'wordCount.indicator',
    label: 'Word count',
    description: 'Words in the book, or in the selection and the book. Choose to see all the counts.',
    shortcut: 'Mod-Shift-g',
  },
  includeFootnotes: {
    id: 'wordCount.includeFootnotes',
    label: 'Include footnotes',
    description: 'Count the text of the footnotes too, here and in the status bar.',
  },
  close: { id: 'wordCount.close', label: 'Close', description: 'Close the word count.', shortcut: 'Escape' },
  done: { id: 'wordCount.done', label: 'Close', description: 'Close the word count.' },
} as const satisfies Record<string, WordCountControlMeta>
