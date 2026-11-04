import { describe, expect, it } from 'vitest'
import { breakPages, MAX_RESERVE_ITERATIONS } from '@/features/pagination'
import { FootnoteRun, type AreaMetrics } from './layout'

/**
 * Footnote reservations through the real page breaker. A synthetic stream: `n` one-line units of
 * 10 px (no widow/orphan effects); line k spans document positions [10k, 10k + 10). Text block:
 * 100 px (10 lines). Footnote lines: 8 px, 6 px above the first note, at most 60 px per page.
 */
const LINE = 10
const H = 100
const METRICS: AreaMetrics = { lineHeight: 8, top: 6, maxHeight: 60 }

function stream(n: number) {
  const lines = Array.from({ length: n }, (_, k) => ({ top: k * LINE, bottom: (k + 1) * LINE, unit: k }))
  const units = lines.map((_, k) => ({ firstLine: k, lineCount: 1, breakBefore: null, keepWithNext: false }))
  return { lines, units }
}

/** Notes referenced from lines `refLines` with `counts` lines each; returns pages + areas + call log. */
function layout(n: number, refLines: number[], counts: number[]) {
  const { lines, units } = stream(n)
  const positions = refLines.map((l) => l * LINE + 5)
  const run = new FootnoteRun(positions, counts, METRICS, n * LINE, H)
  const calls: number[] = []
  const pages = breakPages(lines, units, {
    contentHeight: H,
    reserve: (p, s, e) => {
      calls.push(p)
      return run.reserve({ index: p, from: s * LINE, to: e * LINE })
    },
  })
  return { pages, areas: run.areas, calls }
}

const pageOfLine = (pages: ReturnType<typeof layout>['pages'], line: number) => pages.findIndex((r) => r.startLine <= line && line < r.endLine)

describe('footnote reservations converge (pathological near-the-bottom references)', () => {
  it('a note goes on the page of its reference; body + area never exceed the page', () => {
    const { pages, areas } = layout(40, [2, 15, 23], [2, 3, 1])
    for (const [k, ref] of [2, 15, 23].entries()) {
      const p = pageOfLine(pages, ref)
      expect(areas[p].entries.some((e) => e.note === k && e.start === 0), `note ${k} on page ${p}`).toBe(true)
    }
    pages.forEach((r, p) => {
      const body = (r.endLine - r.startLine) * LINE
      expect(body + (areas[p]?.height ?? 0)).toBeLessThanOrEqual(H)
      expect(areas[p]?.height ?? 0).toBeLessThanOrEqual(r.reserved + 0.01)
    })
  })

  it('REGRESSION: a reference on the last line whose note pushes that line to the next page', () => {
    // Line 9 is the last line of page 0. Its 4-line note (6 + 32 = 38 px) leaves room for 6 lines,
    // so line 9 moves to page 1, and with it the note. Page 0 must not keep the 38 px empty, and
    // the layout must be stable (no oscillation between "line 9 on page 0" and "on page 1").
    const { pages, areas, calls } = layout(30, [9], [4])
    expect(pageOfLine(pages, 9)).toBe(1)
    expect(areas[0].entries).toEqual([])
    // Page 0 keeps every line before the reference's line.
    expect([pages[0].startLine, pages[0].endLine]).toEqual([0, 9])
    expect(areas[1].entries).toEqual([{ note: 0, start: 0, count: 4 }])
    // Bounded work per page: the grow loop, the give-back bisection, one final ask.
    const perPage = new Map<number, number>()
    for (const p of calls) perPage.set(p, (perPage.get(p) ?? 0) + 1)
    for (const c of perPage.values()) expect(c).toBeLessThanOrEqual(MAX_RESERVE_ITERATIONS + 8 + 1)
    // Deterministic: breaking again gives the same pages.
    const again = layout(30, [9], [4])
    expect(again.pages).toEqual(pages)
  })

  it('a note too long for its page continues in the next page’s area', () => {
    // 12-line note (6 + 96 px) referenced from line 1: page 0's area takes the cap (60 px: 6 lines),
    // the other 6 lines continue on page 1.
    const { pages, areas } = layout(30, [1], [12])
    expect(pageOfLine(pages, 1)).toBe(0)
    expect(areas[0].entries).toEqual([{ note: 0, start: 0, count: 6 }])
    expect(areas[1].entries).toEqual([{ note: 0, start: 6, count: 6 }])
    expect(areas[1].continued).toBe(true)
    for (const [p, r] of pages.entries()) expect((r.endLine - r.startLine) * LINE + (areas[p]?.height ?? 0)).toBeLessThanOrEqual(H)
  })

  it('the last page may use the whole text block', () => {
    // 8-line note: 6 + 64 = 70 px, over the 60 px cap of other pages; with 3 body lines it fills 100 px.
    const { pages, areas } = layout(3, [2], [8])
    expect(pages).toHaveLength(1)
    expect(areas[0].entries).toEqual([{ note: 0, start: 0, count: 8 }])
    expect(3 * LINE + areas[0].height).toBeLessThanOrEqual(H)
  })
})
