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

  it('page turns: a CI-advisory measure is reported as not blocking, the others as usual (decision f040009b)', () => {
    const md = toMarkdown([
      {
        scenario: 'pagination-turn',
        browser: 'perf-chromium',
        platform: 'win32',
        turnMedianMs: 10,
        turnMaxMs: 120,
        duringReflowMaxMs: 107.5,
        ciAdvisory: ['duringReflowMaxMs'],
      },
    ])
    expect(md).toMatch(/\| pagination-turn \| chromium \/ win32 \(shipping\) \| 10 \| \*\*120\*\* \(MISS\) \| \*\*107\.5\*\* \(miss, CI-advisory: not blocking\) \|/)
  })

  it('tracked typing (all three markup views) is CI-advisory; other typing still blocks (decision a187e880)', () => {
    const md = toMarkdown([
      {
        scenario: 'perf-track-changes',
        browser: 'perf-chromium',
        platform: 'win32',
        typing: { medianMs: 51, p95Ms: 60, maxMs: 70 },
        typingNoMarkup: { medianMs: 55, p95Ms: 60, maxMs: 70 },
        typingSimpleMarkup: { medianMs: 52, p95Ms: 60, maxMs: 70 },
        ciAdvisory: ['typing', 'typingNoMarkup', 'typingSimpleMarkup'],
      },
      { scenario: 'perf-hotpath', browser: 'perf-chromium', platform: 'win32', typing: { medianMs: 54, p95Ms: 60, maxMs: 70 } },
    ])
    expect(md).toMatch(/\| perf-track-changes \| chromium \/ win32 \(shipping\) \| \*\*51\*\* \(miss, CI-advisory: not blocking\) \|/)
    expect(md).toMatch(/\| perf-track-changes: No Markup \| chromium \/ win32 \(shipping\) \| \*\*55\*\* \(miss, CI-advisory: not blocking\) \|/)
    expect(md).toMatch(/\| perf-track-changes: Simple Markup \| chromium \/ win32 \(shipping\) \| \*\*52\*\* \(miss, CI-advisory: not blocking\) \|/)
    expect(md).toMatch(/\| perf-hotpath \| chromium \/ win32 \(shipping\) \| \*\*54\*\* \(MISS\) \|/)
  })

  it('the style sheet swap is CI-advisory; the repagination it causes still blocks (decision f15842e5)', () => {
    const md = toMarkdown([
      {
        scenario: 'perf-styles',
        browser: 'perf-chromium',
        platform: 'win32',
        restyleMs: 100.4,
        repaginatedMs: 1200,
        allDrawnMs: 1500,
        chaptersRestyled: 30,
        ciAdvisory: ['restyleMs'],
      },
    ])
    expect(md).toMatch(/\| perf-styles \| chromium \/ win32 \(shipping\) \| \*\*100\.4\*\* \(miss, CI-advisory: not blocking\) \| \*\*1200\*\* \(MISS\) \|/)
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

  it('Phase 3: every revision-tools number is in the summary, with its budget and miss marker', () => {
    const md = toMarkdown([
      {
        scenario: 'perf-track-changes',
        browser: 'perf-chromium',
        platform: 'win32',
        markupSwitch: { toNoMarkupMs: 310, toOriginalMs: 1100, toAllMarkupMs: 290, allDrawnWorstMs: 900 },
        replaceAll: { replaced: 10000, ms: 800 },
      },
      { scenario: 'perf-track-changes-review', browser: 'perf-webkit', platform: 'darwin', acceptAll: { ms: 2100 }, rejectAll: { ms: 700 } },
      { scenario: 'comments-panel-layout', browser: 'perf-chromium', platform: 'win32', maxPanelCommitMs: 12.5 },
      { scenario: 'rewrite', browser: 'perf-chromium', platform: 'win32', open: [{ openMs: 120 }, { openMs: 80 }], typing: { medianMs: 9, p95Ms: 20, maxMs: 30 } },
      { scenario: 'rewrite-chapter', browser: 'perf-chromium', platform: 'win32', open: { openMs: 250 }, enterBackspace: { medianMs: 20, p95Ms: 30, maxMs: 40 } },
      { scenario: 'rewrite-keep', browser: 'perf-chromium', platform: 'win32', keep: { reflowMs: 400, allDrawnMs: 500 } },
      {
        scenario: 'phase3-combined',
        browser: 'perf-chromium',
        platform: 'win32',
        typing: { medianMs: 52, p95Ms: 60, maxMs: 70 },
        typingRevision: { medianMs: 5, p95Ms: 18, maxMs: 36 },
        ciAdvisory: ['typing'],
      },
      {
        scenario: 'phase3-mark-only',
        browser: 'perf-chromium',
        platform: 'win32',
        selectAllBold: { ms: 279, allDrawnMs: 280 },
        selectAllBoldTracked: { ms: 1406.6, allDrawnMs: 1407 },
        acceptAllFormatting: { ms: 296.5, allDrawnMs: 297 },
      },
    ])
    const section = md.slice(md.indexOf('#### Revision tools'))
    expect(section).toMatch(/\| perf-track-changes \| markup view switch to No Markup: reflow complete \| chromium \/ win32 \(shipping\) \| 310 \| 1000 \|/)
    expect(section).toMatch(/markup view switch to Original: reflow complete \| chromium \/ win32 \(shipping\) \| \*\*1100\*\* \(MISS\) \| 1000 \|/)
    expect(section).toMatch(/\| Replace All with recording on \| chromium \/ win32 \(shipping\) \| 800 \| 2000 \|/)
    expect(section).toMatch(/\| Accept All of 2,000 changes \(incl\. repagination\) \| webkit \/ darwin \(shipping\) \| \*\*2100\*\* \(miss, warning\) \| 2000 \|/)
    expect(section).toMatch(/\| Reject All of 2,000 changes \(incl\. repagination\) \| webkit \/ darwin \(shipping\) \| 700 \|/)
    expect(section).toMatch(/\| comment panel re-layout after a reflow \(worst trim\) \| chromium \/ win32 \(shipping\) \| 12\.5 \| 100 \|/)
    expect(section).toMatch(/\| open re-write #2 \| chromium \/ win32 \(shipping\) \| 80 \| 300 \|/)
    expect(section).toMatch(/\| rewrite-chapter \| open re-write \| chromium \/ win32 \(shipping\) \| 250 \| 300 \|/)
    expect(section).toMatch(/\| Keep This Version: reflow complete \| chromium \/ win32 \(shipping\) \| 400 \| 1000 \|/)
    expect(section).toMatch(/\| Select All \+ Bold: reflow complete \| chromium \/ win32 \(shipping\) \| 279 \| 1000 \|/)
    expect(section).toMatch(/\| Select All \+ Bold, recording on: reflow complete \| chromium \/ win32 \(shipping\) \| \*\*1406\.6\*\* \(MISS\) \| 1000 \|/)
    expect(section).toMatch(/\| Accept All of the formatting changes: all blocks drawn \| chromium \/ win32 \(shipping\) \| 297 \| 3000 \|/)
    // Typing: the combined scenario (CI-advisory, decision a187e880), the revision and Enter / Backspace.
    expect(md).toMatch(/\| phase3-combined \| chromium \/ win32 \(shipping\) \| \*\*52\*\* \(miss, CI-advisory: not blocking\) \|/)
    expect(md).toMatch(/\| phase3-combined: in the open re-write \| chromium \/ win32 \(shipping\) \| 5 \|/)
    expect(md).toMatch(/\| rewrite-chapter: Enter \/ Backspace \| chromium \/ win32 \(shipping\) \| 20 \|/)
  })

  it('export: the manuscript IR build rows, clean and with pending changes, against 500 ms', () => {
    const md = toMarkdown([
      { scenario: 'perf-export', browser: 'perf-chromium', platform: 'win32', irBuild: { medianMs: 120.5 }, irBuildTracked: { medianMs: 510 } },
    ])
    const section = md.slice(md.indexOf('#### Export'))
    expect(section).toMatch(/\| perf-export \| manuscript IR build \(median\) \| chromium \/ win32 \(shipping\) \| 120\.5 \| 500 \|/)
    expect(section).toMatch(/\| perf-export \| manuscript IR build, 2,000 pending changes \(median\) \| chromium \/ win32 \(shipping\) \| \*\*510\*\* \(MISS\) \| 500 \|/)
  })

  it('every number the export and outline specs write is tabulated, the reported-only ones with no budget', () => {
    const md = toMarkdown([
      { scenario: 'perf-export', browser: 'perf-chromium', platform: 'win32', irBuild: { medianMs: 120, maxMs: 150, fromJsonMedianMs: 33 } },
      { scenario: 'perf-export-docx', browser: 'perf-chromium', platform: 'win32', docxExport: { medianMs: 800, maxMs: 900, framesDuringLastRun: 41 }, docxExportClassic: { medianMs: 700, maxMs: 760 } },
      { scenario: 'perf-navigation-pane', browser: 'perf-chromium', platform: 'win32', outline: { caughtUpMs: 26, lastBuildMs: 4.321 } },
    ])
    expect(md).toContain('| perf-export | manuscript IR build (slowest run; reported) | chromium / win32 (shipping) | 150 | – |')
    expect(md).toContain('| perf-export | manuscript IR from the stored JSON, no editor (median; reported) | chromium / win32 (shipping) | 33 | – |')
    expect(md).toContain('| perf-export-docx | DOCX export (slowest run; reported) | chromium / win32 (shipping) | 900 | – |')
    expect(md).toContain('| perf-export-docx | DOCX export: animation frames painted during the last run (reported) | chromium / win32 (shipping) | 41 | – |')
    expect(md).toContain('| perf-export-docx | DOCX export, Classic preset (slowest run; reported) | chromium / win32 (shipping) | 760 | – |')
    expect(md).toContain('| perf-navigation-pane | last outline build (reported) | chromium / win32 (shipping) | 4.3 | – |')
  })

  it('export: the PDF render of the 100k fixture against 15 s, blocking on Windows, a warning on macOS', () => {
    const md = toMarkdown([
      { scenario: 'pdf-export', browser: 'typst', platform: 'win32', pdfRender: { ms: 2300, pages: 363 } },
      { scenario: 'pdf-export', browser: 'typst', platform: 'darwin', pdfRender: { ms: 15200, pages: 363 } },
    ])
    const section = md.slice(md.indexOf('#### Export'))
    expect(section).toContain('| pdf-export | PDF render, Typst sidecar (363 pages) | typst / win32 (blocking) | 2300 | 15000 |')
    expect(section).toContain('| pdf-export | PDF render, Typst sidecar (363 pages) | typst / darwin | **15200** (miss, warning) | 15000 |')
  })

  it('export: the DOCX export row against 5,000 ms', () => {
    const md = toMarkdown([{ scenario: 'perf-export-docx', browser: 'perf-chromium', platform: 'win32', docxExport: { medianMs: 812.3 }, docxExportClassic: { medianMs: 901 } }])
    const section = md.slice(md.indexOf('#### Export'))
    expect(section).toMatch(/\| perf-export-docx \| DOCX export, 100k words: IR \+ render in the worker \(median\) \| chromium \/ win32 \(shipping\) \| 812\.3 \| 5000 \|/)
    expect(section).toMatch(/\| perf-export-docx \| DOCX export, 100k words, Classic preset \(median\) \| chromium \/ win32 \(shipping\) \| 901 \| 5000 \|/)
  })

  it('live word counts: typing blocks on Windows Chromium like plain typing; the count update is reported (Phase 4)', () => {
    const md = toMarkdown([
      {
        scenario: 'perf-word-count',
        browser: 'perf-chromium',
        platform: 'win32',
        typing: { medianMs: 52, p95Ms: 60, maxMs: 70 },
        wordCount: { caughtUpMs: 180, updateMs: 171.4 },
      },
    ])
    expect(md).toMatch(/\| perf-word-count \| chromium \/ win32 \(shipping\) \| \*\*52\*\* \(MISS\) \|/)
    expect(md).toMatch(/#### Live word count/)
    expect(md).toMatch(/\| perf-word-count \| chromium \/ win32 \(shipping\) \| 171\.4 \| 180 \|/)
  })

  it('navigation pane: the counts after typing (reported) and the outline after a trim reflow, against 1,000 ms (Phase 4)', () => {
    const md = toMarkdown([
      { scenario: 'perf-navigation-pane', browser: 'perf-chromium', platform: 'win32', typing: { medianMs: 22.5, p95Ms: 30, maxMs: 40 }, outline: { caughtUpMs: 26 } },
      {
        scenario: 'perf-outline-reflow',
        browser: 'perf-webkit',
        platform: 'darwin',
        outlineAfterReflow: { runs: [{ trim: 'us-5x8', reflowMs: 700, outlineMs: 1100, lagMs: 400, pages: 600 }, { trim: 'uk-a5', reflowMs: 120, outlineMs: 180, lagMs: 60, pages: 580 }] },
      },
    ])
    const section = md.slice(md.indexOf('#### Navigation pane'))
    expect(md).toMatch(/\| perf-navigation-pane \| chromium \/ win32 \(shipping\) \| 22\.5 \|/)
    expect(section).toMatch(/\| perf-navigation-pane \| counts caught up after typing \(reported\) \| chromium \/ win32 \(shipping\) \| 26 \| – \|/)
    expect(section).toMatch(/\| perf-outline-reflow \| us-5x8: new pages shown after the trim change \(reflow 700, then 400\) \| webkit \/ darwin \(shipping\) \| \*\*1100\*\* \(miss/)
    expect(section).toMatch(/\| perf-outline-reflow \| uk-a5: new pages shown after the trim change \(reflow 120, then 60\) \| webkit \/ darwin \(shipping\) \| 180 \| 1000 \|/)
  })

  it('says so when there are no results', () => {
    expect(toMarkdown([], 'nowhere')).toMatch(/No perf results found in nowhere/)
  })
})
