import type { Mapping } from '@tiptap/pm/transform'
import { entryAt, type Outline, type OutlineEntry } from './model'

/**
 * Stable entry identity. An entry's `key` is its place in the tree ("ch:3" is the fourth chapter), so
 * it names a different chapter after one is added or removed above it. The pane's jumps and its fold
 * state follow a chapter instead: each build gives every entry an id, inherited from the entry it
 * continues (the previous build's entry whose start, carried through the edits since, is where this one
 * starts) or newly minted.
 */
export interface Identified {
  outline: Outline
  /** Entry key to stable id, for this build. */
  ids: ReadonlyMap<string, string>
  /** The edits since this build (appended to as they happen), to carry its positions to the document now. */
  since: Mapping
}

/** The id of each entry of `next`, continuing those of `prev` through `prev.since` (the edits between them). */
export function assignIds(prev: Identified | null, next: Outline, mint: (kind: string) => string): Map<string, string> {
  const carried = new Map<string, string>()
  if (prev) {
    for (const e of prev.outline.flat) {
      if (e.kind === 'front') continue
      const at = prev.since.mapResult(e.from, 1)
      // An entry the edits deleted continues nowhere (its neighbour's start maps onto the same place).
      if (at.deletedAfter) continue
      const id = prev.ids.get(e.key)
      if (id) carried.set(`${e.kind}:${at.pos}`, id)
    }
  }
  const out = new Map<string, string>()
  for (const e of next.flat) {
    if (e.kind === 'front') {
      out.set(e.key, 'front')
      continue
    }
    const slot = `${e.kind}:${e.from}`
    const id = carried.get(slot)
    carried.delete(slot)
    out.set(e.key, id ?? mint(e.kind))
  }
  return out
}

/**
 * The entry of the document as it is now (`current`) that the shown entry `id` continues: where the
 * entry stood when the tree was built, carried through the edits since. Null when the tree has no such id.
 */
export function resolveEntry(shown: Identified, id: string, current: Outline): OutlineEntry | null {
  const entry = shown.outline.flat.find((e) => shown.ids.get(e.key) === id)
  if (!entry) return null
  return entryAt(current, shown.since.map(entry.from, 1))
}
