import type { SliceCreator } from './types'

/**
 * Find & replace panel state. Matches themselves (document positions) are NOT stored here:
 * they live in the editor's find engine / ProseMirror plugin state. The store only holds
 * what the UI renders: options, the query, and O(1) result counters.
 */
export interface FindSlice {
  find: {
    /** Panel visible. While closed, nothing is scanned. */
    open: boolean
    query: string
    replacement: string
    caseSensitive: boolean
    wholeWord: boolean
    /** Index of the current match in document order, or -1 when there is none. */
    currentIndex: number
    matchCount: number
    /** Incremented on every open request (Mod-f, Find button) so the panel can (re)focus its input. */
    focusRequest: number
  }
  /** Named actions: the only way to change `find` state. */
  findActions: {
    /** Open (or re-focus) the panel. `query` pre-fills the search text when given. */
    openPanel: (query?: string) => void
    closePanel: () => void
    setQuery: (query: string) => void
    setReplacement: (replacement: string) => void
    setCaseSensitive: (caseSensitive: boolean) => void
    setWholeWord: (wholeWord: boolean) => void
    /** Published by the find engine after a scan or navigation. */
    setResults: (matchCount: number, currentIndex: number) => void
  }
}

export const createFindSlice: SliceCreator<FindSlice> = (set) => ({
  find: {
    open: false,
    query: '',
    replacement: '',
    caseSensitive: false,
    wholeWord: false,
    currentIndex: -1,
    matchCount: 0,
    focusRequest: 0,
  },
  findActions: {
    openPanel: (query) =>
      set((s) => ({
        find: {
          ...s.find,
          open: true,
          query: query ?? s.find.query,
          focusRequest: s.find.focusRequest + 1,
        },
      })),
    closePanel: () =>
      set((s) => (s.find.open ? { find: { ...s.find, open: false, currentIndex: -1, matchCount: 0 } } : s)),
    setQuery: (query) => set((s) => (s.find.query === query ? s : { find: { ...s.find, query } })),
    setReplacement: (replacement) =>
      set((s) => (s.find.replacement === replacement ? s : { find: { ...s.find, replacement } })),
    setCaseSensitive: (caseSensitive) => set((s) => ({ find: { ...s.find, caseSensitive } })),
    setWholeWord: (wholeWord) => set((s) => ({ find: { ...s.find, wholeWord } })),
    setResults: (matchCount, currentIndex) =>
      set((s) =>
        s.find.matchCount === matchCount && s.find.currentIndex === currentIndex
          ? s
          : { find: { ...s.find, matchCount, currentIndex } },
      ),
  },
})
