import type { SliceCreator } from './types'

/**
 * The project dictionary (Phase 5): words the spell checker accepts in this project, kept in the
 * project's dictionary.json side file. Plain state and setters only: src/features/spellcheck owns the
 * file's format and the rules for a word. The user dictionary is a preference (`spellcheck.words`).
 */
export interface SpellcheckSlice {
  spellcheck: {
    /** The project's words (no case-insensitive duplicates). */
    projectWords: string[]
    /** Bumps on every change the user makes, not on load; storage's guard for a damaged / newer file. */
    version: number
  }
  spellcheckActions: {
    /** Replace the words when the project's dictionary.json is read (or a recovery snapshot restored); not a change. */
    loadProjectWords: (words: string[]) => void
    /** The user changed the project's words. */
    setProjectWords: (words: string[]) => void
  }
}

export const createSpellcheckSlice: SliceCreator<SpellcheckSlice> = (set) => ({
  spellcheck: { projectWords: [], version: 0 },
  spellcheckActions: {
    loadProjectWords: (projectWords) => set((s) => ({ spellcheck: { ...s.spellcheck, projectWords } })),
    setProjectWords: (projectWords) => set((s) => ({ spellcheck: { projectWords, version: s.spellcheck.version + 1 } })),
  },
})
