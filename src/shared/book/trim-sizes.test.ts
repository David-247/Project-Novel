import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MARGINS,
  DEFAULT_TRIM_SIZE,
  getTrimSize,
  inToMm,
  inToPt,
  isTrimSizeId,
  mmToIn,
  mmToPt,
  pageBox,
  ptToIn,
  ptToMm,
  ptToPx,
  pxToPt,
  resolveTrimSize,
  TRIM_SIZES,
  trimSizesByRegion,
} from './index'

describe('unit conversions', () => {
  it('converts between in, mm, pt and CSS px', () => {
    expect(inToPt(1)).toBe(72)
    expect(ptToIn(72)).toBe(1)
    expect(mmToPt(25.4)).toBeCloseTo(72, 10)
    expect(ptToMm(72)).toBeCloseTo(25.4, 10)
    expect(inToMm(1)).toBe(25.4)
    expect(mmToIn(25.4)).toBeCloseTo(1, 10)
    expect(ptToPx(72)).toBe(96)
    expect(pxToPt(96)).toBe(72)
    expect(pxToPt(ptToPx(123.5))).toBeCloseTo(123.5, 10)
    expect(ptToMm(mmToPt(148))).toBeCloseTo(148, 10)
  })
})

describe('trim size catalog', () => {
  it('lists the US and UK/EU sizes from the spec, default first-class', () => {
    expect(trimSizesByRegion('US').map((t) => [t.width / 72, t.height / 72])).toEqual([
      [5, 8],
      [5.25, 8],
      [5.5, 8.5],
      [6, 9],
      [4.25, 6.87],
    ])
    expect(trimSizesByRegion('UK/EU').map((t) => [t.label, Math.round(ptToMm(t.width)), Math.round(ptToMm(t.height))])).toEqual([
      ['A5', 148, 210],
      ['B-format', 129, 198],
      ['Royal', 156, 234],
      ['Demy', 138, 216],
    ])
    expect(TRIM_SIZES).toHaveLength(9)
  })

  it('has unique ids, a default entry whose margins equal DEFAULT_MARGINS, and sane margins', () => {
    expect(new Set(TRIM_SIZES.map((t) => t.id)).size).toBe(TRIM_SIZES.length)
    expect(getTrimSize(DEFAULT_TRIM_SIZE)?.margins).toEqual(DEFAULT_MARGINS)
    for (const t of TRIM_SIZES) {
      const box = pageBox(t, t.margins)
      expect(box.content.width).toBeGreaterThan(box.page.width * 0.6)
      expect(box.content.height).toBeGreaterThan(box.page.height * 0.7)
    }
  })

  it('recognises ids and falls back to the default for unknown ones', () => {
    expect(isTrimSizeId('uk-a5')).toBe(true)
    expect(isTrimSizeId('nope')).toBe(false)
    expect(isTrimSizeId(5)).toBe(false)
    expect(getTrimSize('nope')).toBeUndefined()
    expect(resolveTrimSize('nope').id).toBe(DEFAULT_TRIM_SIZE)
  })
})

describe('pageBox', () => {
  it('returns page and content size in CSS px (96 per inch)', () => {
    const box = pageBox('us-5.5x8.5', { top: 72, bottom: 36, inside: 54, outside: 18 })
    expect(box.page).toEqual({ width: 5.5 * 96, height: 8.5 * 96 })
    expect(box.content.width).toBeCloseTo(5.5 * 96 - (54 + 18) * (96 / 72), 10)
    expect(box.content.height).toBeCloseTo(8.5 * 96 - (72 + 36) * (96 / 72), 10)
  })

  it('accepts a catalog entry, uses the default for unknown ids, and never goes negative', () => {
    const a5 = getTrimSize('uk-a5')!
    expect(pageBox(a5, a5.margins)).toEqual(pageBox('uk-a5', a5.margins))
    expect(pageBox('bogus', DEFAULT_MARGINS).page).toEqual(pageBox(DEFAULT_TRIM_SIZE, DEFAULT_MARGINS).page)
    expect(pageBox('us-5x8', { top: 500, bottom: 500, inside: 500, outside: 500 }).content).toEqual({ width: 0, height: 0 })
  })
})
