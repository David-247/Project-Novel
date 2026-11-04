// @vitest-environment node
import { describe, expect, it } from 'vitest'

// The summary is a plain Node script (scripts/perf-summary.mjs, run in CI); loaded untyped here.
type R = Record<string, unknown>
const SCRIPT: string = '../scripts/perf-summary.mjs'
const { toMarkdown, isShipping, isBlocking } = (await import(/* @vite-ignore */ SCRIPT)) as {
  toMarkdown: (results: R[], dir?: string) => string
  isShipping: (r: R) => boolean
  isBlocking: (r: R) => boolean
}

describe('perf summary', () => {
  it('knows the shipping pairs (decision afbe3475)', () => {
    expect(isShipping({ browser: 'perf-webkit', platform: 'darwin' })).toBe(true)
    expect(isShipping({ browser: 'perf-chromium', platform: 'win32' })).toBe(true)
    expect(isShipping({ browser: 'perf-chromium', platform: 'darwin' })).toBe(false)
    expect(isShipping({ browser: 'perf-webkit', platform: 'win32' })).toBe(false)
  })

  it('in CI only Windows Chromium blocks; macOS WebKit misses are warnings (decision f040009b)', () => {
    expect(isBlocking({ browser: 'perf-chromium', platform: 'win32' })).toBe(true)
    expect(isBlocking({ browser: 'perf-webkit', platform: 'darwin' })).toBe(false)
    expect(isBlocking({ browser: 'perf-webkit', platform: 'win32' })).toBe(false)
    const md = toMarkdown([{ scenario: 'perf', browser: 'perf-webkit', platform: 'darwin', typing: { medianMs: 55, p95Ms: 80, maxMs: 90 } }])
    expect(md).toMatch(/\| perf \| webkit \/ darwin \(shipping\) \| \*\*55\*\* \(miss, warning\) \|/)
  })

  it('tabulates typing, trim reflow, style edit and Replace All; marks misses by pair', () => {
    const md = toMarkdown([
      { scenario: 'perf-combined', browser: 'perf-webkit', platform: 'darwin', openMs: 900, typing: { medianMs: 12.5, p95Ms: 30, maxMs: 41 } },
      { scenario: 'perf', browser: 'perf-webkit', platform: 'win32', typing: { medianMs: 55, p95Ms: 80, maxMs: 90 }, replaceAllMs: 700 },
      {
        scenario: 'pagination-trim',
        browser: 'perf-chromium',
        platform: 'win32',
        reflows: [{ trim: 'uk-a5', ms: 300, allDrawnMs: 500, pages: 420 }],
        maxReflowMs: 1200,
        maxAllDrawnMs: 500,
      },
      { scenario: 'perf-styles', browser: 'perf-chromium', platform: 'darwin', restyleMs: 20, repaginatedMs: 400, allDrawnMs: 600, chaptersRestyled: 40 },
    ])
    expect(md).toMatch(/\| perf-combined \| webkit \/ darwin \(shipping\) \| 12\.5 \| 30 \| 41 \| 900 \|/)
    expect(md).toMatch(/\| perf \| webkit \/ win32 \| \*\*55\*\* \(miss, warning\) \|/)
    expect(md).toMatch(/\| chromium \/ win32 \(shipping\) \| \*\*1200\*\* \(MISS\) \| 500 \| uk-a5 300 \/ 500 \(420\) \|/)
    expect(md).toMatch(/\| chromium \/ darwin \| 20 \| 400 \| 600 \| 40 \|/)
    expect(md).toMatch(/\| webkit \/ win32 \| 700 \|/)
  })

  it('REGRESSION: reports the acceptance Chapter Title style edit timing next to the perf style edit', () => {
    const md = toMarkdown([
      { scenario: 'perf-styles', browser: 'perf-webkit', platform: 'darwin', restyleMs: 60, repaginatedMs: 500, allDrawnMs: 900, chaptersRestyled: 40 },
      {
        scenario: 'acceptance',
        browser: 'perf-webkit',
        platform: 'darwin',
        reflows: [{ trim: 'uk-a5', ms: 300, allDrawnMs: 500, pages: 420 }],
        maxReflowMs: 300,
        maxAllDrawnMs: 500,
        chapterStyleEdit: { ms: 640.2, syncMs: 80, passMs: 210.5, allDrawnMs: 1450 },
      },
      {
        scenario: 'acceptance',
        browser: 'perf-chromium',
        platform: 'win32',
        reflows: [],
        chapterStyleEdit: { ms: 1200, syncMs: 90, passMs: 300, allDrawnMs: 1800 },
      },
    ])
    const section = md.slice(md.indexOf('#### Chapter Title style edit'))
    expect(section).toMatch(/\| perf-styles \| webkit \/ darwin \(shipping\) \| 60 \| 500 \| 900 \| 40 \|/)
    expect(section).toMatch(/\| acceptance \| webkit \/ darwin \(shipping\) \| – \| 640\.2 \| 1450 \| – \|/)
    expect(section).toMatch(/\| acceptance \| chromium \/ win32 \(shipping\) \| – \| \*\*1200\*\* \(MISS\) \| 1800 \| – \|/)
  })

  it('says so when there are no results', () => {
    expect(toMarkdown([], 'nowhere')).toMatch(/No perf results found in nowhere/)
  })
})
