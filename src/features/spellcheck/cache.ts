import { dictionaryVersion } from './dictionary'
import { hashText } from './hash'
import type { Finding } from './types'

/**
 * Findings by block text. The key is the text's hash plus the dictionary version, so unchanged text
 * costs nothing and a new dictionary word makes every block be checked again (a stale entry is never
 * returned, it is just left to age out). Bounded: the oldest entries go first.
 */
export interface FindingCache {
  /** Cached findings for `text` under `version` (default: the dictionary now), or undefined. */
  get(text: string, version?: string): Finding[] | undefined
  set(text: string, findings: Finding[], version?: string): void
  clear(): void
  readonly size: number
}

export const DEFAULT_CACHE_CAPACITY = 5000

export function createFindingCache(capacity = DEFAULT_CACHE_CAPACITY): FindingCache {
  // A Map keeps insertion order: the first key is the oldest (a hit moves its entry to the end).
  const entries = new Map<string, Finding[]>()
  const key = (text: string, version: string) => `${version}|${hashText(text)}`
  return {
    get(text, version = dictionaryVersion()) {
      const k = key(text, version)
      const hit = entries.get(k)
      if (hit) {
        entries.delete(k)
        entries.set(k, hit)
      }
      return hit
    },
    set(text, findings, version = dictionaryVersion()) {
      const k = key(text, version)
      entries.delete(k)
      entries.set(k, findings)
      while (entries.size > capacity) entries.delete(entries.keys().next().value as string)
    },
    clear: () => entries.clear(),
    get size() {
      return entries.size
    },
  }
}
