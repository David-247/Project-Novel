import { describe, expect, it } from 'vitest'
import { breakPages, sideOf, type BreakBefore, type LineBox, type UnitInfo } from './breaker'

interface U {
  lines: number
  breakBefore?: BreakBefore
  keepWithNext?: boolean
  /** Space before the unit (px). */
  gap?: number
}

/** A stream of units with 10px lines. */
function stream(spec: U[]) {
  const lines: LineBox[] = []
  const units: UnitInfo[] = []
  let y = 0
  spec.forEach((u, idx) => {
    y += u.gap ?? 0
    units.push({ firstLine: lines.length, lineCount: u.lines, breakBefore: u.breakBefore ?? null, keepWithNext: !!u.keepWithNext })
    for (let k = 0; k < u.lines; k++) {
      lines.push({ top: y, bottom: y + 10, unit: idx })
      y += 10
    }
  })
  return { lines, units }
}

const ranges = (pages: ReturnType<typeof breakPages>) => pages.map((p) => (p.blank ? 'blank' : [p.startLine, p.endLine]))

describe('breakPages', () => {
  it('an empty document is one page', () => {
    expect(breakPages([], [], { contentHeight: 100 })).toEqual([{ startLine: 0, endLine: 0, blank: false, reserved: 0 }])
  })

  it('fills pages line by line and splits a paragraph at a line boundary', () => {
    // 10 lines per page; one 25-line paragraph -> 10 + 10 + 5.
    const { lines, units } = stream([{ lines: 25 }])
    expect(ranges(breakPages(lines, units, { contentHeight: 100 }))).toEqual([
      [0, 10],
      [10, 20],
      [20, 25],
    ])
  })

  it('counts the space between blocks', () => {
    // 6 lines, 15px gap, 4 lines: 6*10 + 15 + 3*10 = 105 > 100, so only 2 lines of the second fit
    const { lines, units } = stream([{ lines: 6 }, { lines: 6, gap: 15 }])
    expect(ranges(breakPages(lines, units, { contentHeight: 100 }))).toEqual([
      [0, 8],
      [8, 12],
    ])
  })

  it('widows: never leaves a single line at the top of the next page', () => {
    // Page fits 10 lines: 7-line paragraph + 4-line paragraph -> would split 3 / 1; pulls one more line over.
    const { lines, units } = stream([{ lines: 7 }, { lines: 4 }])
    expect(ranges(breakPages(lines, units, { contentHeight: 100 }))).toEqual([
      [0, 9],
      [9, 11],
    ])
  })

  it('orphans: never leaves a single line at the bottom of a page', () => {
    // 9 lines + a 5-line paragraph: only its first line fits -> it moves whole.
    const { lines, units } = stream([{ lines: 9 }, { lines: 5 }])
    expect(ranges(breakPages(lines, units, { contentHeight: 100 }))).toEqual([
      [0, 9],
      [9, 14],
    ])
  })

  it('a 3-line paragraph that cannot satisfy both moves whole', () => {
    // 8 + 2 fit; widows wants 2 on the next page -> 1 would stay -> orphans -> whole paragraph moves
    const a = stream([{ lines: 8 }, { lines: 3 }])
    expect(ranges(breakPages(a.lines, a.units, { contentHeight: 100 }))).toEqual([
      [0, 8],
      [8, 11],
    ])
    // Configurable: 7 + 4 lines with orphans 3 -> the 2/2 split is not allowed either.
    const b = stream([{ lines: 7 }, { lines: 4 }])
    expect(ranges(breakPages(b.lines, b.units, { contentHeight: 100, widows: 2, orphans: 3 }))).toEqual([
      [0, 7],
      [7, 11],
    ])
  })

  it('keeps a heading with the paragraph that follows it', () => {
    const { lines, units } = stream([{ lines: 8 }, { lines: 1, keepWithNext: true }, { lines: 5 }])
    // Heading (line 8) would end page 1 with only one body line fitting -> orphan rule moves the
    // body, keep-with-next then moves the heading too.
    expect(ranges(breakPages(lines, units, { contentHeight: 100 }))).toEqual([
      [0, 8],
      [8, 14],
    ])
  })

  it('a page always progresses, even when the rules would empty it', () => {
    // Heading + a paragraph taller than a page: keep-with-next cannot move the heading off an
    // otherwise empty page.
    const { lines, units } = stream([{ lines: 1, keepWithNext: true }, { lines: 30 }])
    const pages = breakPages(lines, units, { contentHeight: 100 })
    expect(pages[0]).toMatchObject({ startLine: 0, endLine: 10 })
    expect(pages.reduce((s, p) => s + p.endLine - p.startLine, 0)).toBe(31)
  })

  it("breakBefore 'page' starts a new page", () => {
    const { lines, units } = stream([{ lines: 3 }, { lines: 2, breakBefore: 'page' }, { lines: 2 }])
    expect(ranges(breakPages(lines, units, { contentHeight: 100 }))).toEqual([
      [0, 3],
      [3, 7],
    ])
  })

  it("breakBefore 'recto' leaves a blank verso when needed", () => {
    // Page 0 is a recto: chapter 2 would start on page 1 (verso) -> blank page 1, chapter on page 2.
    const { lines, units } = stream([{ lines: 3 }, { lines: 2, breakBefore: 'recto' }, { lines: 15 }, { lines: 2, breakBefore: 'recto' }])
    const pages = breakPages(lines, units, { contentHeight: 100 })
    expect(ranges(pages)).toEqual([[0, 3], 'blank', [3, 13], [13, 20], [20, 22]])
    // Chapter 3 starts after page 3 (verso) -> page 4 is a recto, no blank needed.
    expect(pages.map((_, i) => sideOf(i))).toEqual(['recto', 'verso', 'recto', 'verso', 'recto'])
  })

  it('a break before the very first block is a no-op', () => {
    const { lines, units } = stream([{ lines: 2, breakBefore: 'recto' }, { lines: 2, breakBefore: 'page' }])
    expect(ranges(breakPages(lines, units, { contentHeight: 100 }))).toEqual([
      [0, 2],
      [2, 4],
    ])
  })

  describe('bottom reservations', () => {
    it('reserves space and pushes body lines to the next page', () => {
      const { lines, units } = stream([{ lines: 30 }])
      const pages = breakPages(lines, units, { contentHeight: 100, reserve: (p) => (p === 0 ? 30 : 0) })
      expect(ranges(pages)).toEqual([
        [0, 7],
        [7, 17],
        [17, 27],
        [27, 30],
      ])
      expect(pages[0].reserved).toBe(30)
    })

    it('converges when the need depends on the lines that fit (footnote refs)', () => {
      // A "footnote" of 25px is referenced from line 8: a page holding line 8 needs 25px.
      const { lines, units } = stream([{ lines: 30 }])
      const calls: number[] = []
      const pages = breakPages(lines, units, {
        contentHeight: 100,
        reserve: (_p, s, e) => {
          calls.push(e)
          return s <= 8 && 8 < e ? 25 : 0
        },
      })
      // With 25px reserved only 7 lines fit, so line 8 is no longer on page 0: need 0 <= 25, stop.
      // The space is then given back up to the line before the reference (lines 0-7: 8 lines).
      expect(ranges(pages)[0]).toEqual([0, 8])
      expect(pages[0].reserved).toBe(0)
      expect(ranges(pages)[1]).toEqual([8, 15])
      expect(pages[1].reserved).toBe(25)
      expect(calls.length).toBeLessThan(30)
    })

    it('asks last for the final range of every page (stateful reservations rely on it)', () => {
      const { lines, units } = stream([{ lines: 30 }])
      const last = new Map<number, [number, number]>()
      const pages = breakPages(lines, units, {
        contentHeight: 100,
        reserve: (p, s, e) => {
          last.set(p, [s, e])
          return s <= 8 && 8 < e ? 25 : s <= 19 && 19 < e ? 45 : 0
        },
      })
      pages.forEach((r, p) => expect(last.get(p)).toEqual([r.startLine, r.endLine]))
      // Every page: lines + reservation fit.
      for (const r of pages) expect((r.endLine - r.startLine) * 10 + r.reserved).toBeLessThanOrEqual(100)
    })

    it('cannot oscillate: an ever-growing need stops at the iteration cap', () => {
      const { lines, units } = stream([{ lines: 30 }])
      let n = 0
      const pages = breakPages(lines, units, {
        contentHeight: 100,
        maxReserveIterations: 4,
        reserve: (p) => (p === 0 ? ++n * 5 : 0),
      })
      expect(pages[0].reserveCapped).toBe(true)
      expect(pages[0].reserved).toBe(20)
      // 4 iterations (the final range equals the last one asked, so no extra call).
      expect(n).toBe(4)
    })

    it('clamps silly answers', () => {
      const { lines, units } = stream([{ lines: 5 }])
      const pages = breakPages(lines, units, { contentHeight: 100, reserve: () => Number.NaN })
      expect(pages).toEqual([{ startLine: 0, endLine: 5, blank: false, reserved: 0 }])
      const huge = breakPages(lines, units, { contentHeight: 100, reserve: () => 1e9 })
      // Still progresses one line per page at worst.
      expect(huge.every((p) => p.endLine > p.startLine)).toBe(true)
    })
  })
})
