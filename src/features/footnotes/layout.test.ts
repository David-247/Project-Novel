import { describe, expect, it } from 'vitest'
import { allocateArea, capacityLines, notesInRange, withMarkerLine } from './layout'

const m = { lineHeight: 10, top: 12, maxHeight: 112 } // capacity 10 lines

describe('allocateArea', () => {
  it('is empty (0 px) without notes', () => {
    expect(allocateArea([], [], [], m)).toEqual({ entries: [], lines: 0, height: 0, continued: false, carryOut: [] })
  })

  it('stacks the notes of the page: top + lines x line height', () => {
    const a = allocateArea([], [0, 1], [2, 3], m)
    expect(a.entries).toEqual([
      { note: 0, start: 0, count: 2 },
      { note: 1, start: 0, count: 3 },
    ])
    expect(a.height).toBe(12 + 50)
    expect(a.carryOut).toEqual([])
    expect(a.continued).toBe(false)
  })

  it('splits a long note at a line and carries the rest (and later notes) to the next page', () => {
    const a = allocateArea([], [0, 1], [8, 5], m)
    expect(a.entries).toEqual([
      { note: 0, start: 0, count: 8 },
      { note: 1, start: 0, count: 2 },
    ])
    expect(a.carryOut).toEqual([{ note: 1, start: 2 }])
    const b = allocateArea(a.carryOut, [2], [8, 5, 1], m)
    expect(b.entries).toEqual([
      { note: 1, start: 2, count: 3 },
      { note: 2, start: 0, count: 1 },
    ])
    expect(b.continued).toBe(true)
    expect(b.carryOut).toEqual([])
  })

  it('a note longer than several pages continues page after page', () => {
    let carry = allocateArea([], [0], [25], m)
    const pages = [carry.entries]
    while (carry.carryOut.length) {
      carry = allocateArea(carry.carryOut, [], [25], m)
      pages.push(carry.entries)
    }
    expect(pages).toEqual([[{ note: 0, start: 0, count: 10 }], [{ note: 0, start: 10, count: 10 }], [{ note: 0, start: 20, count: 5 }]])
  })

  it('is monotone: fewer references on the page never need more space', () => {
    const counts = [3, 4, 9, 2]
    for (const carry of [[], [{ note: 0, start: 1 }]]) {
      let prev = Infinity
      for (let k = 3; k >= 0; k--) {
        const notes = [1, 2, 3].slice(0, k)
        const h = allocateArea(carry, notes, counts, m).height
        expect(h).toBeLessThanOrEqual(prev)
        prev = h
      }
    }
  })

  it('always places at least one line (progress), whatever the capacity', () => {
    expect(capacityLines({ lineHeight: 10, top: 12, maxHeight: 5 })).toBe(1)
    expect(allocateArea([], [0], [3], { lineHeight: 10, top: 12, maxHeight: 5 }).entries).toEqual([{ note: 0, start: 0, count: 1 }])
  })
})

describe('notesInRange', () => {
  it('half-open [from, to)', () => {
    const pos = [3, 10, 10, 20, 31]
    expect(notesInRange(pos, 0, 10)).toEqual([0])
    expect(notesInRange(pos, 10, 21)).toEqual([1, 2, 3])
    expect(notesInRange(pos, 31, 32)).toEqual([4])
    expect(notesInRange(pos, 32, 40)).toEqual([])
  })
})

describe('withMarkerLine (the "continued…" marker of a clipped last area)', () => {
  it('frees the last line of the area for the marker', () => {
    expect(withMarkerLine([{ note: 0, start: 0, count: 3 }, { note: 1, start: 0, count: 4 }])).toEqual([
      { note: 0, start: 0, count: 3 },
      { note: 1, start: 0, count: 3 },
    ])
    // A last entry of one line goes; the one before it keeps its lines.
    expect(withMarkerLine([{ note: 0, start: 2, count: 5 }, { note: 1, start: 0, count: 1 }])).toEqual([{ note: 0, start: 2, count: 5 }])
    expect(withMarkerLine([{ note: 0, start: 9, count: 1 }])).toEqual([])
    expect(withMarkerLine([])).toEqual([])
  })
})
