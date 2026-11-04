// @vitest-environment node
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// The comparison is a plain Node script (scripts/compare-pagination.mjs, run in CI); loaded untyped here.
interface Result {
  mode: 'page' | 'recto'
  trim: string
  pageCount: number
  chapterOpenings: number[]
}
interface Run {
  browser: string
  platform: string
  results: Result[]
}
interface Row {
  mode: string
  trim: string
  pagesA: number | null
  pagesB: number | null
  totalDiff: number | null
  totalLimit: number | null
  maxOpeningDrift: number | null
  openingLimit: number
  ok: boolean
  problems: string[]
}
interface PairComparison {
  a: string
  b: string
  shipping: boolean
  ok: boolean
  rows: Row[]
}
const SCRIPT: string = '../scripts/compare-pagination.mjs'
const mod = (await import(/* @vite-ignore */ SCRIPT)) as {
  totalLimit: (a: number, b: number) => number
  openingLimit: (mode: string) => number
  compareRuns: (a: Run, b: Run) => PairComparison
  compareAll: (runs: Run[], opts?: { require?: string[] }) => { ok: boolean; pairs: PairComparison[]; problems: string[] }
  loadRuns: (dir: string) => Run[]
  toMarkdown: (report: { ok: boolean; pairs: PairComparison[]; problems: string[] }) => string
  runKey: (r: Run) => string
}

const run = (browser: string, platform: string, results: Result[]): Run => ({ browser, platform, results })
const res = (mode: 'page' | 'recto', trim: string, pageCount: number, chapterOpenings: number[]): Result => ({
  mode,
  trim,
  pageCount,
  chapterOpenings,
})

describe('cross-engine pagination tolerance', () => {
  it('total pages: max(2 pages, 1 % of the larger count)', () => {
    expect(mod.totalLimit(100, 100)).toBe(2)
    expect(mod.totalLimit(200, 199)).toBe(2)
    expect(mod.totalLimit(300, 303)).toBeCloseTo(3.03)
    expect(mod.totalLimit(450, 440)).toBeCloseTo(4.5)
  })

  it('chapter openings: ±1 on "page", ±2 on "recto" (decision 75522017)', () => {
    expect(mod.openingLimit('page')).toBe(1)
    expect(mod.openingLimit('recto')).toBe(2)
  })

  it('passes runs within tolerance and reports the drift', () => {
    const a = run('webkit', 'darwin', [res('page', 'us-6x9', 300, [0, 10, 20]), res('recto', 'us-6x9', 310, [0, 12, 24])])
    const b = run('chromium', 'win32', [res('page', 'us-6x9', 303, [0, 11, 20]), res('recto', 'us-6x9', 312, [0, 12, 26])])
    const c = mod.compareRuns(a, b)
    expect(c.ok).toBe(true)
    expect(c.shipping).toBe(true)
    expect(c.rows.map((r) => [r.mode, r.trim, r.totalDiff, r.maxOpeningDrift, r.ok])).toEqual([
      ['page', 'us-6x9', 3, 1, true],
      ['recto', 'us-6x9', 2, 2, true],
    ])
  })

  it('fails on a total page difference over the limit', () => {
    const c = mod.compareRuns(run('webkit', 'darwin', [res('page', 'uk-a5', 190, [0])]), run('chromium', 'win32', [res('page', 'uk-a5', 193, [0])]))
    expect(c.ok).toBe(false)
    expect(c.rows[0].problems.join()).toMatch(/total pages differ by 3 \(limit 2\)/)
  })

  it('fails on a chapter opening drift of 2 in "page" mode, but not in "recto" mode', () => {
    const a = run('webkit', 'linux', [res('page', 'uk-a5', 200, [0, 50]), res('recto', 'uk-a5', 200, [0, 50])])
    const b = run('chromium', 'linux', [res('page', 'uk-a5', 200, [0, 52]), res('recto', 'uk-a5', 200, [0, 52])])
    const c = mod.compareRuns(a, b)
    expect(c.rows.map((r) => r.ok)).toEqual([false, true])
    expect(c.rows[0].problems.join()).toMatch(/chapter 2 opens on page 50 vs 52/)
    expect(c.shipping).toBe(false)
  })

  it('fails when a chapter count or a trim/mode result is missing on one side', () => {
    const a = run('webkit', 'darwin', [res('page', 'uk-a5', 200, [0, 50, 90]), res('page', 'us-5x8', 250, [0])])
    const b = run('chromium', 'win32', [res('page', 'uk-a5', 200, [0, 50])])
    const c = mod.compareRuns(a, b)
    expect(c.ok).toBe(false)
    expect(c.rows[0].problems.join()).toMatch(/3 vs 2 chapter openings/)
    expect(c.rows[1].problems.join()).toMatch(/missing/)
  })

  it('compareAll compares every pair, puts the shipping pair first, and requires the named runs', () => {
    const r = (browser: string, platform: string) => run(browser, platform, [res('page', 'uk-a5', 200, [0, 50])])
    const all = mod.compareAll([r('chromium', 'darwin'), r('webkit', 'darwin'), r('chromium', 'win32'), r('webkit', 'win32')], {
      require: ['webkit-darwin', 'chromium-win32'],
    })
    expect(all.ok).toBe(true)
    expect(all.pairs).toHaveLength(6)
    expect(all.pairs[0]).toMatchObject({ a: 'webkit-darwin', b: 'chromium-win32', shipping: true })

    const missing = mod.compareAll([r('chromium', 'darwin'), r('webkit', 'darwin')], { require: ['webkit-darwin', 'chromium-win32'] })
    expect(missing.ok).toBe(false)
    expect(missing.problems.join()).toMatch(/chromium-win32/)
    expect(mod.compareAll([r('webkit', 'darwin')]).ok).toBe(false) // nothing to compare
  })

  it('loads the fixture JSONs from nested artifact folders', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pg-'))
    mkdirSync(join(dir, 'pagination-fixture-macos-latest'))
    mkdirSync(join(dir, 'pagination-fixture-windows-latest'))
    writeFileSync(join(dir, 'pagination-fixture-macos-latest', 'pagination-fixture-webkit-darwin.json'), JSON.stringify(run('webkit', 'darwin', [])))
    writeFileSync(join(dir, 'pagination-fixture-windows-latest', 'pagination-fixture-chromium-win32.json'), JSON.stringify(run('chromium', 'win32', [])))
    writeFileSync(join(dir, 'pagination-fixture-windows-latest', 'perf-chromium-win32.json'), '{}')
    expect(mod.loadRuns(dir).map(mod.runKey).sort()).toEqual(['chromium-win32', 'webkit-darwin'])
  })

  it('renders a markdown diff table with the failing rows marked', () => {
    const a = run('webkit', 'darwin', [res('page', 'uk-a5', 200, [0, 50])])
    const b = run('chromium', 'win32', [res('page', 'uk-a5', 205, [0, 53])])
    const md = mod.toMarkdown(mod.compareAll([a, b]))
    expect(md).toMatch(/### Cross-engine page breaks/)
    expect(md).toMatch(/webkit-darwin vs chromium-win32 \(shipping pair\)/)
    expect(md).toMatch(/\| page \| uk-a5 \| 200 \| 205 \| 5 \/ 2\.05 \| 3 \/ 1 \| FAIL/)
  })
})
