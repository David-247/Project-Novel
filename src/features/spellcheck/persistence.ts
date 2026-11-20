import { registerSideFile, type ProjectSideFile } from '@/features/storage'
import { readDictionaryWords, useStore } from '@/shared/store'

/**
 * dictionary.json as a project side file (storage slice): `{ version: 1, words: string[] }`, the words
 * this project's spell checker accepts (character names, places). Read on open, written with the
 * manuscript, snapshotted by autosave, guarded when damaged or newer. Unknown top-level keys are written
 * back unchanged; unreadable entries of `words` (not strings, too long, with spaces) are dropped.
 */
export const DICTIONARY_FILE = 'dictionary.json'
export const DICTIONARY_VERSION = 1

let fileExtra: Record<string, unknown> = {}

export const dictionarySideFile: ProjectSideFile = {
  name: DICTIONARY_FILE,
  load(data) {
    const raw = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>
    const { version, words, ...extra } = raw
    fileExtra = extra
    useStore.getState().spellcheckActions.loadProjectWords(readDictionaryWords(words))
    if (typeof version === 'number' && Number.isFinite(version) && version > DICTIONARY_VERSION) return { newer: version }
  },
  serialize() {
    const words = useStore.getState().spellcheck.projectWords
    return {
      data: { ...fileExtra, version: DICTIONARY_VERSION, words },
      empty: words.length === 0 && Object.keys(fileExtra).length === 0,
    }
  },
  getVersion: () => useStore.getState().spellcheck.version,
}

/** Register dictionary.json with the storage slice (once, at app start). Returns unregister. */
export function registerDictionarySideFile(): () => void {
  return registerSideFile(dictionarySideFile)
}

/** Test-only. */
export function __resetDictionaryFileForTests(): void {
  fileExtra = {}
}
