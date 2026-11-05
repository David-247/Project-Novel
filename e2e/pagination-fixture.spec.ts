import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import { buildPaginationFixture } from './fixtures/pagination-manuscript'
import { launch, openRecent, saveStatus, seedProject, waitForLayout } from './helpers'

/**
 * Cross-engine pagination fixture (input to the Phase 2 acceptance comparison; tolerance decisions:
 * total pages differ <= max(2, 1%), each chapter opening page index differs <= 1, or <= 2 when
 * chapters open on a right-hand page).
 *
 * The deterministic ~100k-word fixture is typeset in a bundled OFL font (Libre Baskerville,
 * e2e/fixtures/fonts, see OFL.txt there) so system fonts do not differ between machines. Chapter
 * headings start a new page (data-break-before, as a style definition would emit it), in two
 * modes: 'page' (any page) and 'recto' (next right-hand page; a one-page drift then moves an
 * opening by two). For every mode and trim size this records the total page count and each
 * chapter's opening page index to
 * perf-results/pagination-fixture-<browser>-<platform>.json (and the test report).
 */

/**
 * Phase 3: the tracked-changes variant (hidden text takes no space). Every third paragraph gets a
 * deleted run of eight of its words and an inserted run of eight new words, and every 25th paragraph
 * is a tracked paragraph split; then the fixture is typeset in No Markup (deletions hidden) and All
 * Markup (both shown) at a few trims, chapters on a new page. Same tolerance (c945d094, 75522017).
 */
const TRACKED_TRIMS = ['us-5x8', 'us-5.5x8.5', 'us-6x9', 'uk-a5']
const MARKUPS = ['none', 'all'] as const

type Run = { type: string; text?: string; marks?: unknown[] }
type Block = { type: string; attrs?: Record<string, unknown>; content?: Run[] }

function trackedVariant(doc: { content: unknown[] }) {
  const stamp = (id: string) => ({ id, author: 'Ann', date: '2026-01-01T00:00:00.000Z', authorColor: null })
  let paragraph = 0
  let changes = 0
  const content = (doc.content as Block[]).map((b, i) => {
    if (b.type !== 'paragraph') return b
    paragraph++
    let out: Block = b
    const last = b.content!.at(-1)!
    const w = (last.text ?? '').split(' ')
    if (paragraph % 3 === 0 && w.length >= 20) {
      const keep = last.marks ? { marks: last.marks } : {}
      const extra = (last.marks as unknown[]) ?? []
      out = {
        ...b,
        content: [
          ...b.content!.slice(0, -1),
          { type: 'text', text: w.slice(0, 6).join(' ') + ' ', ...keep },
          { type: 'text', text: w.slice(6, 14).join(' ') + ' ', marks: [...extra, { type: 'deletion', attrs: stamp(`d${i}`) }] },
          { type: 'text', text: 'and then the lantern went out again ', marks: [...extra, { type: 'insertion', attrs: stamp(`i${i}`) }] },
          { type: 'text', text: w.slice(14).join(' '), ...keep },
        ],
      }
      changes += 2
    }
    if (paragraph % 25 === 0) {
      out = { ...out, attrs: { ...(out.attrs ?? {}), trackedInsert: stamp(`s${i}`) } }
      changes++
    }
    return out
  })
  return { doc: { type: 'doc', content }, changes }
}

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

  type Result = { mode: 'page' | 'recto'; markup?: 'none' | 'all'; trim: string; pageCount: number; chapterOpenings: number[] }
  const results: Result[] = []
  const openings = async () => {
    const l = await page.evaluate(() => window.__nvE2E.layout())
    const out: number[] = []
    for (const p of l.pages) if (!p.isBlank && p.startsBlockType === 'heading' && p.chapterIndex === out.length) out.push(p.index)
    return { pageCount: l.pageCount, chapterOpenings: out }
  }
  for (const mode of ['page', 'recto'] as const) {
    await page.evaluate((m) => window.__nvE2E.breakBeforeBlocks({ type: 'heading', level: 1 }, m), mode)
    for (const trim of TRIMS) {
      await page.evaluate((id) => window.__nvE2E.setTrimSize(id), trim)
      await waitForLayout(page)
      results.push({ mode, trim, ...(await openings()) })
    }
  }

  // Phase 3: the tracked-changes variant in No Markup and All Markup.
  const tracked = trackedVariant(fx.doc)
  await page.evaluate((d) => window.__nvE2E.setDoc(d), tracked.doc)
  await page.evaluate(() => window.__nvE2E.breakBeforeBlocks({ type: 'heading', level: 1 }, 'page'))
  await waitForLayout(page)
  expect(await page.evaluate(() => window.__nvE2E.countChanges())).toBe(tracked.changes)
  for (const markup of MARKUPS) {
    await page.evaluate((m) => window.__nvE2E.setMarkupView(m), markup)
    for (const trim of TRACKED_TRIMS) {
      await page.evaluate((id) => window.__nvE2E.setTrimSize(id), trim)
      await waitForLayout(page)
      results.push({ mode: 'page', markup, trim, ...(await openings()) })
    }
  }
  // Hidden text takes no space: No Markup (deletions hidden) is shorter than All Markup.
  for (const trim of TRACKED_TRIMS) {
    const pages = (m: string) => results.find((r) => r.markup === m && r.trim === trim)!.pageCount
    expect(pages('none'), `tracked ${trim}: No Markup vs All Markup pages`).toBeLessThan(pages('all'))
  }

  const out = {
    scenario: 'pagination-fixture',
    browser: testInfo.project.name,
    platform: process.platform,
    font: 'Libre Baskerville (OFL), book styles at 96/72 px per point',
    manuscript: { words: fx.words, chapters: fx.chapters, blocks: fx.doc.content.length, trackedChanges: tracked.changes },
    // Applied by scripts/compare-pagination.mjs (CI job "Cross-engine page breaks").
    tolerance: { totalPages: 'max(2, 1%)', chapterOpening: { page: 1, recto: 2 } },
    results,
    measuredAt: new Date().toISOString(),
  }
  console.info(`[pagination-fixture] ${JSON.stringify(out)}`)
  mkdirSync('perf-results', { recursive: true })
  writeFileSync(`perf-results/pagination-fixture-${testInfo.project.name}-${process.platform}.json`, JSON.stringify(out, null, 2))
  await testInfo.attach('pagination-fixture.json', { body: JSON.stringify(out, null, 2), contentType: 'application/json' })

  for (const r of results) {
    const label = `${r.mode}${r.markup ? ` tracked/${r.markup}` : ''} ${r.trim}`
    expect(r.chapterOpenings, label).toHaveLength(fx.chapters)
    // Chapters open in order; with 'recto' always on a right-hand page (even index).
    expect(r.chapterOpenings.every((p, i) => (r.mode === 'page' || p % 2 === 0) && (i === 0 || p > r.chapterOpenings[i - 1])), label).toBe(true)
    expect(r.pageCount, label).toBeGreaterThan(150)
  }
})
