import { dictionaryWords, dictionaryVersion, isIgnored } from './dictionary'
import { createFindingCache } from './cache'
import { spellCheck } from './ipc'
import type { Block, Finding } from './types'

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
