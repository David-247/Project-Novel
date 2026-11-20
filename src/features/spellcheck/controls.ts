/**
 * Stable identities, names and descriptions of the spell check's controls. The tooltips registry
 * derives its entries from here; View ▸ Spelling & Grammar reads its copy from its registry command.
 */
export interface SpellcheckControlMeta {
  id: string
  label: string
  description: string
}

export const SPELLCHECK_CONTROLS = {
  toggle: {
    id: 'view.spellcheck',
    label: 'Spelling & Grammar',
    description: 'Underline possible spelling (red) and grammar (blue) mistakes. Right-click one for suggestions.',
  },
  suggestion: {
    id: 'spellcheck.suggestion',
    label: 'Suggestion',
    description: 'Replace the underlined text with this suggestion.',
  },
  noSuggestions: {
    id: 'spellcheck.noSuggestions',
    label: 'No suggestions',
    description: 'The checker has no replacement to offer for this text.',
  },
  ignoreOnce: {
    id: 'spellcheck.ignoreOnce',
    label: 'Ignore Once',
    description: 'Stop underlining this one occurrence until you close Novel.',
  },
  addToDictionary: {
    id: 'spellcheck.addToDictionary',
    label: 'Add to Dictionary',
    description: 'Accept this word everywhere, in every project (your dictionary in Novel’s preferences).',
  },
} as const satisfies Record<string, SpellcheckControlMeta>

export type SpellcheckControlKey = keyof typeof SPELLCHECK_CONTROLS
