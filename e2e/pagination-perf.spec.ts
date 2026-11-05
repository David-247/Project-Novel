import { mkdirSync, writeFileSync } from 'node:fs'
import { expect, test, type Page, type TestInfo } from '@playwright/test'
import { budget } from './budget'
import { buildPaginationFixture } from './fixtures/pagination-manuscript'
import { clickBlockStart, editor, launch, lineEnd, openRecent, saveStatus, seedProject, waitForLayout } from './helpers'

/**
 * Pagination performance budget on a 100,000-word manuscript (serial perf projects, like
 * perf.spec.ts; chromium ~ WebView2, webkit ~ WKWebView):
 *  - trim size change: set -> page model published and the pages in view drawn and painted, < 1 s
 *    for every catalog trim size (off-screen blocks drawn progressively after; < 3 s);
 *  - typing latency while paginated (keydown -> next frame painted), median < 50 ms, p95 reported:
 *    (a) at the end of a line of a mid-manuscript paragraph, (b) inside a paragraph split across two pages
 *    (every wrapped line moves a line between pages and re-decorates the rest of the book).
 * Numbers go to perf-results/pagination-*.json and the report.
 */

const WARMUP = 5
const MEASURED = 40
const TYPED = 'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do'.slice(0, WARMUP + MEASURED)
/** Every catalog trim size, ending on the default (us-5.5x8.5) the book opened with. */
const TRIMS = ['us-6x9', 'us-5x8', 'uk-a5', 'us-5.25x8', 'us-mass-market', 'uk-b-format', 'uk-royal', 'uk-demy', 'us-5.5x8.5']

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
  // Running heads and page numbers are on (the defaults): the budgets below include them.
  await expect(page.locator('.nv-frames [data-hf="text"], .nv-frames [data-hf="number"]').first()).toBeAttached()
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

/**
 * A caret-placing key before measuring: wait for its own latency sample, then start clean (else
 * its late sample lands among the typed ones, as perf.spec.ts does for its End key).
 */
async function navKey(page: Page, press: () => Promise<void>) {
  await page.evaluate(() => ((window as unknown as { __perf: number[] }).__perf = []))
  await press()
  await page.waitForFunction(() => (window as unknown as { __perf: number[] }).__perf.length >= 1)
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
  const reflows: { trim: string; ms: number; allDrawnMs: number; syncMs: number; firstPass: unknown; pages: number }[] = []
  for (const trim of TRIMS) {
    const r = await page.evaluate(async (id) => {
      const v = window.__nvE2E.layout().layoutVersion
      const t0 = performance.now()
      window.__nvE2E.setTrimSize(id)
      const firstPass = window.__nvE2E.paginationLines().lastPass
      const syncMs = performance.now() - t0
      // "Reflow complete" (docs/pagination.md): the new page model is published (every page break
      // of the book computed) and the pages in view are drawn at their new place, painted.
      await new Promise<void>((resolve) => {
        const check = () =>
          window.__nvE2E.paginationModelSettled() && window.__nvE2E.layout().layoutVersion > v ? resolve() : requestAnimationFrame(check)
        requestAnimationFrame(check)
      })
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)))
      const ms = performance.now() - t0
      // Off-screen blocks receive their offsets in the following frames: also report when all are drawn.
      await new Promise<void>((resolve) => {
        const check = () => (window.__nvE2E.paginationSettled() ? resolve() : requestAnimationFrame(check))
        check()
      })
      return { ms, allDrawnMs: performance.now() - t0, syncMs, firstPass }
    }, trim)
    reflows.push({ trim, ms: +r.ms.toFixed(1), allDrawnMs: +r.allDrawnMs.toFixed(1), syncMs: +r.syncMs.toFixed(1), firstPass: r.firstPass, pages: (await page.evaluate(() => window.__nvE2E.layout())).pageCount })
  }
  await report(testInfo, 'pagination-trim', {
    manuscript: { words: fx.words, chapters: fx.chapters, blocks: fx.doc.content.length },
    openMs,
    initialPages,
    reflows,
    maxReflowMs: Math.max(...reflows.map((r) => r.ms)),
    maxAllDrawnMs: Math.max(...reflows.map((r) => r.allDrawnMs)),
    budgets: { reflowMs: 1000, allDrawnMs: 3000 },
  })
  expect(reflows.at(-1)!.pages).toBe(initialPages)
  for (const r of reflows) budget(testInfo, `${r.trim}: all blocks drawn ms`, r.allDrawnMs, 3000)
  for (const r of reflows) budget(testInfo, `${r.trim}: reflow complete ms`, r.ms, 1000)
})

test('100k words paginated: typing latency (end of a line; inside a paragraph split across pages)', async ({ page }, testInfo) => {
  test.setTimeout(180_000)
  const { fx, openMs } = await openFixture(page, '/projects/Typing')
  const ed = editor(page)
  await installLatencyProbe(page)

  // (a) End of the first line of a mid-manuscript paragraph.
  await clickBlockStart(page, ed.locator('p').nth(Math.floor((await ed.locator('p').count()) / 2)))
  await navKey(page, () => lineEnd(page))
  const endOfLine = await typeAndMeasure(page)

  // (b) Inside a paragraph whose last lines continue on the next page.
  // (Index found natively: Playwright's own :has engine is slow over 1,300 paragraphs.)
  const splitIndex = await ed.evaluate((root) => {
    const ps = Array.from(root.querySelectorAll(':scope > p'))
    return ps.indexOf(ps.filter((p) => p.querySelector(':scope > span.nv-shift'))[40])
  })
  expect(splitIndex).toBeGreaterThan(0)
  await clickBlockStart(page, ed.locator(':scope > p').nth(splitIndex))
  await navKey(page, () => page.keyboard.press('ArrowRight'))
  const splitParagraph = await typeAndMeasure(page)
  await waitForLayout(page)
  expect(await ed.evaluate((el, t) => el.textContent!.split(t).length - 1, TYPED)).toBe(2)

  await report(testInfo, 'pagination-typing', {
    manuscript: { words: fx.words, chapters: fx.chapters, blocks: fx.doc.content.length },
    openMs,
    pages: (await page.evaluate(() => window.__nvE2E.layout())).pageCount,
    endOfLine,
    splitParagraph,
    budgets: { typingMedianMs: 50 },
  })
  for (const t of [endOfLine, splitParagraph]) {
    expect(t.keystrokes).toBeGreaterThanOrEqual(20)
    budget(testInfo, 'typing median ms', t.medianMs, 50)
  }
})

/**
 * In the page: turn and resolve once the turned-to spread is painted, with how long it took and
 * whether it was fully drawn in that first painted frame (every frame in the one-spread window, no
 * hidden .nv-stale block in it, text painted near the top of each page's text block).
 */
async function timedTurn(page: Page, how: 'next' | 'last' | 'first') {
  return page.evaluate(async (h) => {
    const t0 = performance.now()
    if (h === 'next') window.__nvE2E.turnSpread(1)
    else window.__nvE2E.edgeSpread(h === 'last' ? 1 : -1)
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => {
        const ch = new MessageChannel()
        ch.port1.onmessage = () => resolve()
        ch.port2.postMessage(null)
      }),
    )
    const ms = performance.now() - t0
    const root = document.querySelector('.novel-editor-content')
    const sizer = document.querySelector('.nv-sizer')!.getBoundingClientRect()
    const frames = Array.from(document.querySelectorAll<HTMLElement>('.nv-frames .nv-page'))
    const stale = Array.from(document.querySelectorAll('.novel-editor-content .nv-stale')).filter((el) => {
      const r = el.getBoundingClientRect()
      return r.bottom > sizer.top && r.top < sizer.bottom
    }).length
    const unpainted = frames.filter((f) => {
      if (f.dataset.blank) return false
      const r = f.getBoundingClientRect()
      for (const fx of [0.3, 0.5, 0.7])
        for (const fy of [0.15, 0.25, 0.35, 0.5]) {
          const el = document.elementFromPoint(r.left + r.width * fx, r.top + r.height * fy)
          if (el && el !== root && el.closest('.novel-editor-content')) return false
        }
      return true
    }).length
    const inside = frames.every((f) => {
      const r = f.getBoundingClientRect()
      return r.top >= sizer.top - 1 && r.bottom <= sizer.bottom + 1
    })
    return { ms, stale, unpainted, inside, frames: frames.length, spread: window.__nvE2E.layout().visibleSpread.index }
  }, how)
}

test('100k words, Book mode: a page turn shows a fully drawn spread < 100 ms (also during a progressive reflow)', async ({ page }, testInfo) => {
  test.setTimeout(180_000)
  const { fx } = await openFixture(page, '/projects/Turn')
  expect(await page.evaluate(() => window.__nvE2E.pageNavigation())).toBe('book')
  const turns: Awaited<ReturnType<typeof timedTurn>>[] = []
  for (let i = 0; i < 12; i++) turns.push(await timedTurn(page, 'next'))
  turns.push(await timedTurn(page, 'last'))
  turns.push(await timedTurn(page, 'first'))
  // A turn while a trim reflow is still drawing off-screen blocks: the far spread is drawn first.
  const progressive: Awaited<ReturnType<typeof timedTurn>>[] = []
  for (const [trim, how] of [['us-6x9', 'last'], ['us-5.5x8.5', 'next'], ['uk-a5', 'first'], ['us-5.5x8.5', 'last']] as const) {
    await page.evaluate((id) => window.__nvE2E.setTrimSize(id), trim)
    progressive.push(await timedTurn(page, how))
    await waitForLayout(page)
  }
  const all = [...turns, ...progressive]
  const sorted = turns.map((t) => t.ms).sort((a, b) => a - b)
  await report(testInfo, 'pagination-turn', {
    manuscript: { words: fx.words, chapters: fx.chapters, blocks: fx.doc.content.length },
    pages: (await page.evaluate(() => window.__nvE2E.layout())).pageCount,
    turnMedianMs: +pct(sorted, 50).toFixed(1),
    turnMaxMs: +Math.max(...turns.map((t) => t.ms)).toFixed(1),
    duringReflowMaxMs: +Math.max(...progressive.map((t) => t.ms)).toFixed(1),
    turns: all.map((t) => ({ ...t, ms: +t.ms.toFixed(1) })),
    budgets: { turnMs: 100 },
  })
  // Functional (always blocking): every turn painted a complete spread in its first frame.
  for (const t of all) expect(t, JSON.stringify(t)).toMatchObject({ stale: 0, unpainted: 0, inside: true })
  for (const t of all) budget(testInfo, 'page turn: fully drawn spread ms', t.ms, 100)
})
