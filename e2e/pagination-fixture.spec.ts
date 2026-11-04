import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import { buildPaginationFixture } from './fixtures/pagination-manuscript'
import { launch, openRecent, saveStatus, seedProject, waitForLayout } from './helpers'

/**
 * Cross-engine pagination fixture (input to the Phase 2 acceptance comparison; tolerance decision:
 * total pages differ <= max(2, 1%), each chapter opening page index differs <= 1).
 *
 * The deterministic ~100k-word fixture is typeset in a bundled OFL font (Libre Baskerville,
 * e2e/fixtures/fonts, see OFL.txt there) so system fonts do not differ between machines. Chapter
 * headings start a new page (data-break-before, as a style definition would emit it), in two
 * modes: 'page' (any page) and 'recto' (next right-hand page; a one-page drift then moves an
 * opening by two). For every mode and trim size this records the total page count and each
 * chapter's opening page index to
 * perf-results/pagination-fixture-<browser>-<platform>.json (and the test report).
 */

const TRIMS = ['us-5x8', 'us-5.25x8', 'us-5.5x8.5', 'us-6x9', 'us-mass-market', 'uk-a5', 'uk-b-format', 'uk-royal', 'uk-demy']
const font = (file: string) => readFileSync(new URL(`./fixtures/fonts/${file}`, import.meta.url)).toString('base64')

test('cross-engine fixture: chapter opening pages and page totals per trim size', async ({ page }, testInfo) => {
  test.setTimeout(240_000)
  await page.setViewportSize({ width: 1400, height: 900 })
  const fx = buildPaginationFixture()
  await launch(page)
  await seedProject(page, '/projects/Fixture', 'Fixture', fx.doc)
  await openRecent(page, '/projects/Fixture')
  await expect(saveStatus(page)).toHaveText('Fixture: All changes saved', { timeout: 60_000 })

  await page.addStyleTag({
    content: `
      @font-face { font-family: 'NvFixtureSerif'; font-weight: 400; src: url(data:font/woff2;base64,${font('libre-baskerville-latin-400-normal.woff2')}) format('woff2'); }
      @font-face { font-family: 'NvFixtureSerif'; font-weight: 700; src: url(data:font/woff2;base64,${font('libre-baskerville-latin-700-normal.woff2')}) format('woff2'); }
      .nv-text-layer .novel-editor-content, .nv-text-layer .novel-editor-content * { font-family: 'NvFixtureSerif', serif !important; }
    `,
  })
  await page.evaluate(async () => {
    await Promise.all([document.fonts.load("400 11pt 'NvFixtureSerif'"), document.fonts.load("700 11pt 'NvFixtureSerif'")])
  })
  expect(await page.evaluate(() => document.fonts.check("400 11pt 'NvFixtureSerif'"))).toBe(true)

  const results: { mode: 'page' | 'recto'; trim: string; pageCount: number; chapterOpenings: number[] }[] = []
  for (const mode of ['page', 'recto'] as const) {
    await page.evaluate((m) => window.__nvE2E.breakBeforeBlocks({ type: 'heading', level: 1 }, m), mode)
    for (const trim of TRIMS) {
      await page.evaluate((id) => window.__nvE2E.setTrimSize(id), trim)
      await waitForLayout(page)
      const l = await page.evaluate(() => window.__nvE2E.layout())
      const openings: number[] = []
      for (const p of l.pages) if (!p.isBlank && p.startsBlockType === 'heading' && p.chapterIndex === openings.length) openings.push(p.index)
      results.push({ mode, trim, pageCount: l.pageCount, chapterOpenings: openings })
    }
  }

  const out = {
    scenario: 'pagination-fixture',
    browser: testInfo.project.name,
    platform: process.platform,
    font: 'Libre Baskerville (OFL), book styles at 96/72 px per point',
    manuscript: { words: fx.words, chapters: fx.chapters, blocks: fx.doc.content.length },
    tolerance: { totalPages: 'max(2, 1%)', chapterOpening: 1 },
    results,
    measuredAt: new Date().toISOString(),
  }
  console.info(`[pagination-fixture] ${JSON.stringify(out)}`)
  mkdirSync('perf-results', { recursive: true })
  writeFileSync(`perf-results/pagination-fixture-${testInfo.project.name}-${process.platform}.json`, JSON.stringify(out, null, 2))
  await testInfo.attach('pagination-fixture.json', { body: JSON.stringify(out, null, 2), contentType: 'application/json' })

  for (const r of results) {
    const label = `${r.mode} ${r.trim}`
    expect(r.chapterOpenings, label).toHaveLength(fx.chapters)
    // Chapters open in order; with 'recto' always on a right-hand page (even index).
    expect(r.chapterOpenings.every((p, i) => (r.mode === 'page' || p % 2 === 0) && (i === 0 || p > r.chapterOpenings[i - 1])), label).toBe(true)
    expect(r.pageCount, label).toBeGreaterThan(150)
  }
})
