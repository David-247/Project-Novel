import { describe, expect, it } from 'vitest'
import { DEFAULT_MARGINS } from '@/shared/book'
import { resolvePageGeometry } from './geometry'
import { DESK_PAD, effectiveView, placePages, resolveScale, ROW_GAP, stepZoom } from './placement'

const g = resolvePageGeometry('us-5.5x8.5', DEFAULT_MARGINS)

describe('resolvePageGeometry (book settings pageBox)', () => {
  it('converts the trim to px at 96/in and margins from points at 96/72', () => {
    expect(g.pageWidth).toBe(528)
    expect(g.pageHeight).toBe(816)
    expect(g.margins).toEqual({ top: 72, bottom: 72, inside: 84, outside: 60 })
    expect(g.contentWidth).toBe(528 - 84 - 60)
    expect(g.contentHeight).toBe(816 - 144)
  })

  it('uses the catalog and falls back for unknown ids', () => {
    expect(resolvePageGeometry('us-6x9', DEFAULT_MARGINS)).toMatchObject({ pageWidth: 576, pageHeight: 864 })
    expect(resolvePageGeometry('uk-a5', DEFAULT_MARGINS).pageWidth).toBeCloseTo((148 / 25.4) * 96, 1)
    expect(resolvePageGeometry('nope', DEFAULT_MARGINS)).toEqual(g)
  })

  it('never yields an empty text block', () => {
    const silly = resolvePageGeometry('us-5x8', { top: 400, bottom: 400, inside: 300, outside: 300 })
    expect(silly.contentWidth).toBeGreaterThan(0)
    expect(silly.contentHeight).toBeGreaterThan(0)
  })
})

describe('placePages', () => {
  it('spread: page 0 is a recto alone, then verso|recto pairs touching at the spine', () => {
    const p = placePages(5, g, 'spread')
    expect(p.rowCount).toBe(3)
    expect(p.pagesInRow(0)).toEqual([0, 0])
    expect(p.pagesInRow(1)).toEqual([1, 2])
    expect(p.pagesInRow(2)).toEqual([3, 4])
    expect(p.frame(0)).toMatchObject({ x: DESK_PAD + g.pageWidth, y: DESK_PAD })
    expect(p.frame(1)).toMatchObject({ x: DESK_PAD, y: DESK_PAD + g.pageHeight + ROW_GAP })
    expect(p.frame(2).x).toBe(p.frame(1).x + g.pageWidth)
    expect(p.canvasWidth).toBe(2 * g.pageWidth + 2 * DESK_PAD)
  })

  it('mirrors margins: outside margin on the fore-edge, inside on the spine', () => {
    const p = placePages(3, g, 'spread')
    // Verso (page 1): outside margin on the left.
    expect(p.content(1).x - p.frame(1).x).toBe(g.margins.outside)
    // Recto (page 2): inside margin on the left.
    expect(p.content(2).x - p.frame(2).x).toBe(g.margins.inside)
    expect(p.content(2).y - p.frame(2).y).toBe(g.margins.top)
  })

  it('single: one page per row, still mirrored', () => {
    const p = placePages(3, g, 'single')
    expect(p.rowCount).toBe(3)
    expect(p.pagesInRow(2)).toEqual([2, 2])
    expect(p.frame(2).y).toBe(DESK_PAD + 2 * (g.pageHeight + ROW_GAP))
    expect(p.content(1).x - p.frame(1).x).toBe(g.margins.outside)
    expect(p.content(0).x - p.frame(0).x).toBe(g.margins.inside)
  })

  it('rowAtY clamps and splits the gap between rows', () => {
    const p = placePages(5, g, 'spread')
    expect(p.rowAtY(-1000)).toBe(0)
    expect(p.rowAtY(DESK_PAD + g.pageHeight + ROW_GAP + 10)).toBe(1)
    expect(p.rowAtY(1e9)).toBe(2)
  })
})

describe('view and zoom', () => {
  it('falls back to single pages when two would be unreadably small', () => {
    expect(effectiveView('spread', 1400, g)).toBe('spread')
    expect(effectiveView('spread', 500, g)).toBe('single')
    expect(effectiveView('single', 3000, g)).toBe('single')
    // Unknown width (not measured yet): keep the request.
    expect(effectiveView('spread', 0, g)).toBe('spread')
  })

  it('resolves fit-spread, fit-width and percentages', () => {
    const p = placePages(10, g, 'spread')
    const vp = { width: p.canvasWidth, height: 500 }
    expect(resolveScale({ mode: 'fit-width', percent: 100 }, vp, p, g)).toBe(1)
    expect(resolveScale({ mode: 'fit-spread', percent: 100 }, vp, p, g)).toBeCloseTo(500 / (g.pageHeight + 2 * DESK_PAD), 2)
    expect(resolveScale({ mode: 'percent', percent: 150 }, vp, p, g)).toBe(1.5)
  })

  it('steps through the zoom presets', () => {
    expect(stepZoom(1, 1)).toBe(125)
    expect(stepZoom(1, -1)).toBe(75)
    expect(stepZoom(0.87, 1)).toBe(100)
    expect(stepZoom(0.3, -1)).toBe(50)
    expect(stepZoom(3, 1)).toBe(200)
  })
})
