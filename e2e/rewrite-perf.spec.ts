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
 * And at chapter scale (a chapter of 250 paragraphs, 8,000 words, re-written whole): open < 300 ms;
 * Enter and Backspace (a paragraph added, then joined back: the alignment is redone) median < 50 ms.
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

/** The 100k-word fixture with a 250-paragraph, 8,000-word chapter inserted in the middle; its first paragraph. */
function chapterFixture() {
  const fx = buildPaginationFixture()
  const content = fx.doc.content as { type: string }[]
  const words = 'the river quiet lantern stone window garden letter morning shadow silver harbor whisper meadow candle thunder orchard ribbon compass feather journey kitchen mountain doorway'.split(' ')
  const at = content.findIndex((n, i) => n.type === 'heading' && i > content.length / 2)
  const chapter = [
    { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Chapter Long: Two Hundred and Fifty' }] },
    ...Array.from({ length: CHAPTER_PARAGRAPHS }, (_, i) => {
      const w = Array.from({ length: 32 }, (_, k) => words[(i * 11 + k * 7) % words.length])
      w[0] = w[0][0].toUpperCase() + w[0].slice(1)
      return { type: 'paragraph', content: [{ type: 'text', text: `${w.join(' ')} ${i}.` }] }
    }),
  ]
  content.splice(at, 0, ...chapter)
  return { fx: { ...fx, words: fx.words + CHAPTER_PARAGRAPHS * 33 }, first: at + 1 }
}
const CHAPTER_PARAGRAPHS = 250

async function openFixture(page: Page, folder: string, make: () => ReturnType<typeof fixture> = fixture) {
  const { fx, first } = make()
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

/** Re-write Passage… on blocks first..first+count-1: ms to the view aligned and painted. */
async function timeOpen(page: Page, first: number, count = PARAGRAPHS): Promise<{ openMs: number; readyMs: number; rows: number }> {
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
    [first, count] as const,
  )
}

/** Record keydown -> next frame painted for every key press (window.__perf). */
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

/** Press each key, waiting for its frame; the latencies after the warm-up. */
async function measureKeys(page: Page, keys: string[]) {
  await page.evaluate(() => ((window as unknown as { __perf: number[] }).__perf = []))
  for (const [i, key] of keys.entries()) {
    await page.keyboard.press(key)
    await page.waitForFunction((k) => (window as unknown as { __perf: number[] }).__perf.length >= k, i + 1)
  }
  const all = await page.evaluate(() => (window as unknown as { __perf: number[] }).__perf)
  const sorted = all.slice(WARMUP).sort((a, b) => a - b)
  return { keystrokes: sorted.length, medianMs: +pct(sorted, 50).toFixed(2), p95Ms: +pct(sorted, 95).toFixed(2), maxMs: +sorted[sorted.length - 1].toFixed(2) }
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
  await installLatencyProbe(page)
  await rev.locator('p').nth(9).click()
  await page.keyboard.press('End')
  const typing = await measureKeys(page, [...TYPED].map((ch) => (ch === ' ' ? 'Space' : ch)))
  await expect(rev).toContainText(TYPED.slice(0, 20))

  await report(testInfo, 'rewrite', { manuscript: { words: fx.words, blocks: fx.doc.content.length }, paragraphs: PARAGRAPHS, open: runs, typing, budgets: { openMs: 300, typingMedianMs: 50 } })
  for (const [i, r] of runs.entries()) budget(testInfo, `open re-write #${i + 1} ms (20 paragraphs, 100k words)`, r.openMs, 300)
  expect(typing.keystrokes).toBeGreaterThanOrEqual(20)
  budget(testInfo, 'typing median ms (re-write revision)', typing.medianMs, 50)
})

test('re-write of a whole 250-paragraph chapter (8,000 words): open < 300 ms, Enter / Backspace median < 50 ms', async ({ page }, testInfo) => {
  test.setTimeout(240_000)
  const { fx, first } = await openFixture(page, '/projects/RewriteChapter', chapterFixture)
  await editor(page).click()
  const open = await timeOpen(page, first, CHAPTER_PARAGRAPHS)
  expect(open.rows).toBe(CHAPTER_PARAGRAPHS)
  const rev = page.getByRole('textbox', { name: 'Revised passage' })
  await expect(rev).toBeFocused()

  // Split a paragraph mid-chapter and join it back, again and again: the paragraph count changes
  // every time (re-pairing, re-levelling of every later block).
  await installLatencyProbe(page)
  await rev.locator('p').nth(125).click()
  await page.keyboard.press('Home')
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowRight')
  const keys: string[] = []
  for (let i = 0; i < (WARMUP + MEASURED) / 2 + 1; i++) keys.push('Enter', 'Backspace')
  const typing = await measureKeys(page, keys)
  await expect(rev.locator('p')).toHaveCount(CHAPTER_PARAGRAPHS)
  // The pairs are redone after the pause: one row per paragraph again, all unchanged.
  await expect.poll(async () => (await page.evaluate(() => window.__nvE2E.rewrite())).debug.rows.every((k) => k === 'same')).toBe(true)

  await report(testInfo, 'rewrite-chapter', {
    manuscript: { words: fx.words, blocks: fx.doc.content.length },
    paragraphs: CHAPTER_PARAGRAPHS,
    passageWords: CHAPTER_PARAGRAPHS * 33,
    open: { openMs: +open.openMs.toFixed(1), readyMs: +open.readyMs.toFixed(1), rows: open.rows },
    enterBackspace: typing,
    budgets: { openMs: 300, typingMedianMs: 50 },
  })
  budget(testInfo, 'open re-write ms (250-paragraph chapter)', open.openMs, 300)
  expect(typing.keystrokes).toBeGreaterThanOrEqual(20)
  budget(testInfo, 'Enter / Backspace median ms (250-paragraph revision)', typing.medianMs, 50)
})
