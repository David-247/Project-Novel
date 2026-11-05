import { mkdirSync, writeFileSync } from 'node:fs'
import { expect, test, type Page, type TestInfo } from '@playwright/test'
import { budget } from './budget'
import { buildPaginationFixture } from './fixtures/pagination-manuscript'
import { editor, launch, openRecent, saveStatus, seedProject, waitForLayout } from './helpers'

/**
 * Re-write performance (serial perf projects): the 100,000-word manuscript.
 *  - opening a re-write on a 20-paragraph passage: from Re-write Passage… to the comparison view
 *    aligned and painted, < 300 ms;
 *  - typing in the revision (keydown -> next frame painted), median < 50 ms.
 * Gating: e2e/budget.ts (decision f040009b). Numbers go to perf-results/rewrite-*.json.
 */

const PARAGRAPHS = 20
const WARMUP = 5
const MEASURED = 40
const TYPED = 'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do'.slice(0, WARMUP + MEASURED)
const pct = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]

/** The fixture and the first block of a run of PARAGRAPHS paragraphs inside one chapter, mid-manuscript. */
function fixture() {
  const fx = buildPaginationFixture()
  const content = fx.doc.content as { type: string }[]
  const headings = content.map((n, i) => (n.type === 'heading' ? i : -1)).filter((i) => i >= 0)
  for (const h of headings.slice(Math.floor(headings.length / 2))) {
    const next = headings.find((x) => x > h) ?? content.length
    if (next - h - 2 >= PARAGRAPHS) return { fx, first: h + 2 }
  }
  throw new Error('no chapter with enough paragraphs')
}

async function openFixture(page: Page, folder: string) {
  const { fx, first } = fixture()
  await launch(page)
  const title = folder.split('/').pop()!
  await seedProject(page, folder, title, fx.doc)
  await openRecent(page, folder)
  await expect(saveStatus(page)).toHaveText(`${title}: All changes saved`, { timeout: 60_000 })
  await waitForLayout(page)
  return { fx, first }
}

async function report(testInfo: TestInfo, name: string, result: Record<string, unknown>) {
  const full = { scenario: name, browser: testInfo.project.name, platform: process.platform, ...result, measuredAt: new Date().toISOString() }
  console.info(`[perf] ${JSON.stringify(full)}`)
  mkdirSync('perf-results', { recursive: true })
  writeFileSync(`perf-results/${name}-${testInfo.project.name}-${process.platform}.json`, JSON.stringify(full, null, 2))
  await testInfo.attach(`${name}.json`, { body: JSON.stringify(full, null, 2), contentType: 'application/json' })
}

/** Re-write Passage… on blocks first..first+PARAGRAPHS-1: ms to the view aligned and painted. */
async function timeOpen(page: Page, first: number): Promise<{ openMs: number; readyMs: number; rows: number }> {
  return page.evaluate(
    async ([a, n]) => {
      const e = window.__nvE2E
      e.selectText(e.blockPos(a) + 2, e.blockPos(a + n - 1) + 2)
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)))
      const t0 = performance.now()
      if (!e.runCommand('rewrite.open')) throw new Error('Re-write Passage… is disabled')
      await new Promise<void>((resolve) => {
        const check = () => (e.rewrite().debug.readyAt > t0 ? resolve() : requestAnimationFrame(check))
        check()
      })
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => {
          const ch = new MessageChannel()
          ch.port1.onmessage = () => resolve()
          ch.port2.postMessage(null)
        }),
      )
      const d = e.rewrite().debug
      return { openMs: performance.now() - t0, readyMs: d.readyAt - t0, rows: d.rows.length }
    },
    [first, PARAGRAPHS] as const,
  )
}

test('re-write on a 20-paragraph passage at 100k words: open < 300 ms, typing median < 50 ms', async ({ page }, testInfo) => {
  test.setTimeout(240_000)
  const { fx, first } = await openFixture(page, '/projects/RewritePerf')
  await editor(page).click()

  // Open (new re-write: snapshot, anchors, the view), close, then reopen the same draft.
  const runs: { openMs: number; readyMs: number; rows: number }[] = []
  for (let k = 0; k < 2; k++) {
    const r = await timeOpen(page, first)
    runs.push({ openMs: +r.openMs.toFixed(1), readyMs: +r.readyMs.toFixed(1), rows: r.rows })
    expect(r.rows).toBe(PARAGRAPHS)
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('rewrite-view')).toHaveCount(0)
    await waitForLayout(page)
  }

  // Typing in the revision: the end of the first line of its 10th paragraph.
  await page.evaluate(() => window.__nvE2E.runCommand('rewrite.next'))
  const rev = page.getByRole('textbox', { name: 'Revised passage' })
  await expect(rev).toBeFocused()
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
  await rev.locator('p').nth(9).click()
  await page.keyboard.press('End')
  await page.waitForFunction(() => (window as unknown as { __perf: number[] }).__perf.length >= 1)
  await page.evaluate(() => ((window as unknown as { __perf: number[] }).__perf = []))
  for (const [i, ch] of [...TYPED].entries()) {
    await page.keyboard.press(ch === ' ' ? 'Space' : ch)
    await page.waitForFunction((k) => (window as unknown as { __perf: number[] }).__perf.length >= k, i + 1)
  }
  const all = await page.evaluate(() => (window as unknown as { __perf: number[] }).__perf)
  const sorted = all.slice(WARMUP).sort((a, b) => a - b)
  const typing = { keystrokes: sorted.length, medianMs: +pct(sorted, 50).toFixed(2), p95Ms: +pct(sorted, 95).toFixed(2), maxMs: +sorted[sorted.length - 1].toFixed(2) }
  await expect(rev).toContainText(TYPED.slice(0, 20))

  await report(testInfo, 'rewrite', { manuscript: { words: fx.words, blocks: fx.doc.content.length }, paragraphs: PARAGRAPHS, open: runs, typing, budgets: { openMs: 300, typingMedianMs: 50 } })
  for (const [i, r] of runs.entries()) budget(testInfo, `open re-write #${i + 1} ms (20 paragraphs, 100k words)`, r.openMs, 300)
  expect(typing.keystrokes).toBeGreaterThanOrEqual(20)
  budget(testInfo, 'typing median ms (re-write revision)', typing.medianMs, 50)
})
