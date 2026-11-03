import { mkdirSync, writeFileSync } from 'node:fs'
import { expect, test, type Page, type TestInfo } from '@playwright/test'
import { buildPaginationFixture } from './fixtures/pagination-manuscript'
import { editor, launch, openRecent, saveStatus, seedProject, waitForLayout } from './helpers'

/**
 * Pagination performance budget on a 100,000-word manuscript (serial perf projects, like
 * perf.spec.ts; chromium ~ WebView2, webkit ~ WKWebView):
 *  - trim size change: set -> reflowed model published -> painted, < 1 s for each of four trims;
 *  - typing latency while paginated (keydown -> next frame painted), median < 50 ms, p95 reported:
 *    (a) at the end of a mid-manuscript paragraph, (b) inside a paragraph split across two pages
 *    (every wrapped line moves a line between pages and re-decorates the rest of the book).
 * Numbers go to perf-results/pagination-*.json and the report.
 */

const WARMUP = 5
const MEASURED = 40
const TYPED = 'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do'.slice(0, WARMUP + MEASURED)
const TRIMS = ['us-6x9', 'us-5x8', 'a5', 'us-5.5x8.5']

const pct = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]

async function openFixture(page: Page, folder: string) {
  const fx = buildPaginationFixture()
  await launch(page)
  const title = folder.split('/').pop()!
  await seedProject(page, folder, title, fx.doc)
  const t0 = Date.now()
  await openRecent(page, folder)
  await expect(saveStatus(page)).toHaveText(`${title}: All changes saved`, { timeout: 60_000 })
  await waitForLayout(page)
  return { fx, openMs: Date.now() - t0 }
}

async function report(testInfo: TestInfo, name: string, result: Record<string, unknown>) {
  const full = { scenario: name, browser: testInfo.project.name, platform: process.platform, ...result, measuredAt: new Date().toISOString() }
  console.info(`[perf] ${JSON.stringify(full)}`)
  mkdirSync('perf-results', { recursive: true })
  writeFileSync(`perf-results/${name}-${testInfo.project.name}-${process.platform}.json`, JSON.stringify(full, null, 2))
  await testInfo.attach(`${name}.json`, { body: JSON.stringify(full, null, 2), contentType: 'application/json' })
}

async function installLatencyProbe(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __perf: number[] }
    w.__perf = []
    window.addEventListener(
      'keydown',
      (e) => {
        const now = performance.now()
        const t0 = e.timeStamp > 0 && e.timeStamp <= now && now - e.timeStamp < 1000 ? e.timeStamp : now
        requestAnimationFrame(() => {
          const ch = new MessageChannel()
          ch.port1.onmessage = () => w.__perf.push(performance.now() - t0)
          ch.port2.postMessage(null)
        })
      },
      true,
    )
  })
}

/** Type WARMUP + MEASURED characters at the caret, each waiting for its own paint; summarize. */
async function typeAndMeasure(page: Page) {
  await page.evaluate(() => ((window as unknown as { __perf: number[] }).__perf = []))
  for (const [i, ch] of [...TYPED].entries()) {
    await page.keyboard.press(ch === ' ' ? 'Space' : ch)
    await page.waitForFunction((k) => (window as unknown as { __perf: number[] }).__perf.length >= k, i + 1)
  }
  const all = await page.evaluate(() => (window as unknown as { __perf: number[] }).__perf)
  const sorted = all.slice(WARMUP).sort((a, b) => a - b)
  return {
    keystrokes: sorted.length,
    medianMs: +pct(sorted, 50).toFixed(2),
    p95Ms: +pct(sorted, 95).toFixed(2),
    maxMs: +sorted[sorted.length - 1].toFixed(2),
  }
}

test('100k words paginated: trim size reflow < 1 s', async ({ page }, testInfo) => {
  test.setTimeout(180_000)
  const { fx, openMs } = await openFixture(page, '/projects/Trim')
  const initialPages = (await page.evaluate(() => window.__nvE2E.layout())).pageCount
  const reflows: { trim: string; ms: number; pages: number }[] = []
  for (const trim of TRIMS) {
    const ms = await page.evaluate(async (id) => {
      const v = window.__nvE2E.layout().layoutVersion
      const t0 = performance.now()
      window.__nvE2E.setTrimSize(id)
      await new Promise<void>((resolve) => {
        const check = () =>
          window.__nvE2E.paginationSettled() && window.__nvE2E.layout().layoutVersion > v ? resolve() : requestAnimationFrame(check)
        requestAnimationFrame(check)
      })
      // Include the paint of the new layout.
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)))
      return performance.now() - t0
    }, trim)
    reflows.push({ trim, ms: +ms.toFixed(1), pages: (await page.evaluate(() => window.__nvE2E.layout())).pageCount })
  }
  await report(testInfo, 'pagination-trim', {
    manuscript: { words: fx.words, chapters: fx.chapters, blocks: fx.doc.content.length },
    openMs,
    initialPages,
    reflows,
    maxReflowMs: Math.max(...reflows.map((r) => r.ms)),
    budgets: { reflowMs: 1000 },
  })
  expect(reflows.at(-1)!.pages).toBe(initialPages)
  for (const r of reflows) expect(r.ms, r.trim).toBeLessThan(1000)
})

test('100k words paginated: typing latency (end of paragraph; inside a paragraph split across pages)', async ({ page }, testInfo) => {
  test.setTimeout(180_000)
  const { fx, openMs } = await openFixture(page, '/projects/Typing')
  const ed = editor(page)
  await installLatencyProbe(page)

  // (a) End of a mid-manuscript paragraph: click its first line, then End of paragraph.
  const mid = ed.locator('p').nth(Math.floor((await ed.locator('p').count()) / 2))
  await mid.scrollIntoViewIfNeeded()
  await mid.click({ position: { x: 4, y: 4 } })
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.press('ControlOrMeta+Home')
  await mid.click({ position: { x: 4, y: 4 } })
  await page.keyboard.press('End')
  const endOfParagraph = await typeAndMeasure(page)

  // (b) Inside a paragraph whose last lines continue on the next page.
  const split = ed.locator('p:has(> span.nv-shift)').nth(40)
  await split.scrollIntoViewIfNeeded()
  await split.click({ position: { x: 4, y: 4 } })
  await page.keyboard.press('ArrowRight')
  const splitParagraph = await typeAndMeasure(page)
  await waitForLayout(page)
  await expect(ed).toContainText(TYPED)

  await report(testInfo, 'pagination-typing', {
    manuscript: { words: fx.words, chapters: fx.chapters, blocks: fx.doc.content.length },
    openMs,
    pages: (await page.evaluate(() => window.__nvE2E.layout())).pageCount,
    endOfParagraph,
    splitParagraph,
    budgets: { typingMedianMs: 50 },
  })
  for (const t of [endOfParagraph, splitParagraph]) {
    expect(t.keystrokes).toBeGreaterThanOrEqual(20)
    expect(t.medianMs).toBeLessThan(50)
  }
})
