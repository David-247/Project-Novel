import { describe, expect, it } from 'vitest'
import { Mapping, StepMap } from '@tiptap/pm/transform'
import { assignIds, resolveEntry, type Identified } from './identity'
import type { Outline, OutlineEntry } from './model'

const entry = (index: number, from: number, to: number): OutlineEntry => ({
  key: `ch:${index}`,
  kind: 'chapter',
  level: 1,
  chapterIndex: index,
  title: '',
  label: '',
  number: index + 1,
  from,
  to,
  children: [],
})
const outline = (...e: OutlineEntry[]): Outline => ({ entries: e, chapters: [], flat: e })
const counter = () => {
  let n = 0
  return () => `id${++n}`
}
const mapping = (...ranges: [number, number, number][]) => {
  const m = new Mapping()
  for (const r of ranges) m.appendMap(new StepMap(r))
  return m
}

describe('stable entry ids', () => {
  const first = outline(entry(0, 0, 10), entry(1, 10, 20), entry(2, 20, 30))
  const a: Identified = { outline: first, ids: assignIds(null, first, counter()), since: new Mapping() }

  it('a chapter keeps its id when one is inserted above it (its key moves, its id does not)', () => {
    // 12 characters inserted at 0: every chapter moves by 12, and a new one opens at 0.
    const next = outline(entry(0, 0, 12), entry(1, 12, 22), entry(2, 22, 32), entry(3, 32, 42))
    const ids = assignIds({ ...a, since: mapping([0, 0, 12]) }, next, () => 'fresh')
    expect(ids.get('ch:1')).toBe(a.ids.get('ch:0'))
    expect(ids.get('ch:2')).toBe(a.ids.get('ch:1'))
    expect(ids.get('ch:3')).toBe(a.ids.get('ch:2'))
    expect(ids.get('ch:0')).not.toBe(a.ids.get('ch:0'))
  })

  it('a deleted chapter is gone and its neighbours keep their ids', () => {
    const next = outline(entry(0, 0, 10), entry(1, 10, 20))
    const ids = assignIds({ ...a, since: mapping([10, 10, 0]) }, next, counter())
    expect(ids.get('ch:0')).toBe(a.ids.get('ch:0'))
    expect(ids.get('ch:1')).toBe(a.ids.get('ch:2'))
  })

  it('resolves a click to the chapter that was clicked, after chapters were added above it', () => {
    const shown: Identified = { ...a, since: mapping([0, 0, 12]) }
    const now = outline(entry(0, 0, 12), entry(1, 12, 22), entry(2, 22, 32), entry(3, 32, 42))
    // The row said "ch:1", but that index is the first of the old chapters in the document now.
    expect(resolveEntry(shown, a.ids.get('ch:1')!, now)?.from).toBe(22)
    expect(resolveEntry(shown, 'nope', now)).toBeNull()
  })
})
