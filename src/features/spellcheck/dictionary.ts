import { MAX_DICTIONARY_WORD_LENGTH, MAX_DICTIONARY_WORDS, readDictionaryWords, useStore } from '@/shared/store'
import { sideFileChanged } from '@/features/storage'
import { hashText } from './hash'
import type { DictionaryScope, Finding } from './types'

/**
 * The writer's dictionary: the user's words (preferences.json, `spellcheck.words`, every project) and
 * the project's (dictionary.json, a storage side file; see persistence.ts). Rust compares words
 * without case, so "aelinor" covers "Aelinor".
 */

/** A word as it would be stored (trimmed, one word), or null when it cannot be one. */
export function normalizeWord(word: string): string | null {
  const w = word.trim()
  if (w === '' || w.length > MAX_DICTIONARY_WORD_LENGTH || /\s/.test(w)) return null
  return w
}

const userWords = () => useStore.getState().preferences.spellcheck.words
const projectWords = () => useStore.getState().spellcheck.projectWords

/** Every word the checker accepts: the user's and the project's, without case-insensitive duplicates. */
export function dictionaryWords(): string[] {
  return readDictionaryWords([...userWords(), ...projectWords()])
}

/**
 * Identifies the dictionary's content: it changes when a word is added or removed in either scope
 * (also when a project opens), so findings cached under an older one are not used.
 */
export function dictionaryVersion(): string {
  const key = dictionaryWords()
    .map((w) => w.toLowerCase())
    .sort()
    .join('\n')
  return hashText(key)
}

/**
 * Add a word. 'user': every project (preferences.json). 'project': this project (dictionary.json; the
 * project then has unsaved changes). Returns false when the word is not acceptable or already there.
 */
export function addWord(word: string, scope: DictionaryScope): boolean {
  const w = normalizeWord(word)
  if (!w) return false
  const state = useStore.getState()
  const list = scope === 'user' ? userWords() : projectWords()
  if (list.length >= MAX_DICTIONARY_WORDS || list.some((x) => x.toLowerCase() === w.toLowerCase())) return false
  if (scope === 'user') {
    state.preferencesActions.set('spellcheck', { words: [...list, w] })
  } else {
    state.spellcheckActions.setProjectWords([...list, w])
    sideFileChanged()
  }
  return true
}

/** Remove a word from one scope (case-insensitive). Returns false when it was not there. */
export function removeWord(word: string, scope: DictionaryScope): boolean {
  const key = word.trim().toLowerCase()
  const list = scope === 'user' ? userWords() : projectWords()
  const next = list.filter((x) => x.toLowerCase() !== key)
  if (next.length === list.length) return false
  const state = useStore.getState()
  if (scope === 'user') {
    state.preferencesActions.set('spellcheck', { words: next })
  } else {
    state.spellcheckActions.setProjectWords(next)
    sideFileChanged()
  }
  return true
}

/** Findings the writer chose to ignore, for this session only (never saved). */
const ignored = new Set<string>()

const ignoreKey = (blockKey: string, f: Finding) => `${blockKey}|${f.start}|${f.end}|${f.rule}`

/**
 * Ignore one finding until the app closes. `blockKey` is the key the caller checks the block under
 * (checkBlocks uses the block id). An edit that moves the finding makes it a different one, so an
 * ignore only holds while the text before the finding is unchanged.
 */
export function ignoreOnce(blockKey: string, finding: Finding): void {
  ignored.add(ignoreKey(blockKey, finding))
}

export function isIgnored(blockKey: string, finding: Finding): boolean {
  return ignored.has(ignoreKey(blockKey, finding))
}

/** Test-only. */
export function __resetIgnoredForTests(): void {
  ignored.clear()
}
