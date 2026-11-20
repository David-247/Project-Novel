// Public interface of the "spellcheck" slice (Phase 5): the offline spell and grammar engine.
// Other slices import ONLY from here. docs/project-format.md, "dictionary.json".
//
// Harper (harper-core, Rust, src-tauri/src/spellcheck.rs) checks plain-text blocks on the blocking pool
// and returns findings with UTF-16 offsets. The dialect follows the OS locale (en-GB: British, else US).
//
// - checkBlocks(blocks): Promise<Map<blockId, Finding[]>>. Unchanged text is answered from a cache keyed by
//   the text's hash plus the dictionary version; only changed blocks go to Rust (one call). Findings the
//   writer ignored (ignoreOnce) are left out.
// - addWord(word, 'user' | 'project'): the user dictionary is preferences.json `spellcheck.words`, the
//   project's is the dictionary.json side file. dictionaryWords() lists both.
// - registerDictionarySideFile() once at start (composition root).
import { dictionaryWords, dictionaryVersion, isIgnored } from './dictionary'
import { createFindingCache } from './cache'
import { spellCheck } from './ipc'
import type { Block, Finding } from './types'

export type { Finding, Block, DictionaryScope } from './types'
export { addWord, removeWord, ignoreOnce, isIgnored, dictionaryWords, dictionaryVersion, normalizeWord } from './dictionary'
export { createFindingCache, type FindingCache } from './cache'
export { registerDictionarySideFile, DICTIONARY_FILE } from './persistence'

const cache = createFindingCache()

/**
 * Check blocks (`id`, plain `text`). Resolves to the findings of every block by id (an empty array when
 * clean). Rejects when the engine fails; nothing is cached then. A dictionary change while the check runs
 * is not lost: the results are stored under the dictionary they were checked with.
 */
export async function checkBlocks(blocks: Block[]): Promise<Map<string, Finding[]>> {
  const version = dictionaryVersion()
  const found = new Map<string, Finding[]>()
  const misses = new Map<string, Block[]>() // text -> the blocks that hold it
  for (const b of blocks) {
    const hit = cache.get(b.text, version)
    if (hit) found.set(b.id, hit)
    else misses.set(b.text, [...(misses.get(b.text) ?? []), b])
  }
  if (misses.size > 0) {
    const send = [...misses.entries()].map(([text, holders]) => ({ id: holders[0].id, text }))
    const results = await spellCheck(send, dictionaryWords())
    const byId = new Map(results.map((r) => [r.id, r.findings]))
    for (const [text, holders] of misses) {
      const findings = byId.get(holders[0].id) ?? []
      cache.set(text, findings, version)
      for (const h of holders) found.set(h.id, findings)
    }
  }
  const out = new Map<string, Finding[]>()
  for (const b of blocks) {
    const findings = found.get(b.id) ?? []
    out.set(b.id, findings.some((f) => isIgnored(b.id, f)) ? findings.filter((f) => !isIgnored(b.id, f)) : findings)
  }
  return out
}

/** Test-only: forget every cached finding. */
export function __resetSpellcheckCacheForTests(): void {
  cache.clear()
}
