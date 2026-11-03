import { mkdirSync, writeFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import { editor, launch, openRecent, saveStatus, seedProject } from './helpers'

/**
 * Performance budget on a 100,000-word manuscript, in real browser engines
 * (chromium ~ WebView2, webkit ~ WKWebView):
 *  - typing latency: keydown -> next animation frame -> after that frame (input-to-paint),
 *    median < 50 ms over 40 measured keystrokes (5 warm-up keystrokes discarded); p95 reported;
 *  - Replace All of a common word: click -> "Replaced N" shown and painted, < 2 s.
 * Numbers are written to perf-results/perf-<browser>.json (CI artifact) and attached to the report.
 */

const WORDS = 100_000
const WORDS_PER_PARAGRAPH = 100
const VOCAB = [
  'night', 'river', 'quiet', 'lantern', 'stone', 'window', 'garden', 'letter', 'morning', 'shadow',
  'silver', 'harbor', 'whisper', 'meadow', 'candle', 'thunder', 'orchard', 'ribbon', 'compass', 'feather',
]
/** Every 10th word is "the": 10,000 occurrences to replace. */
const THE_EVERY = 10

function buildManuscript() {
  let n = 0
  const word = () => (n++ % THE_EVERY === 0 ? 'the' : VOCAB[(n * 7) % VOCAB.length])
  const content: unknown[] = []
  for (let p = 0; n < WORDS; p++) {
    const count = Math.min(WORDS_PER_PARAGRAPH, WORDS - n)
    const words = Array.from({ length: count }, word)
    if (p % 25 === 0) {
      // Chapter heading (its words count toward the total).
      content.push({ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: words.join(' ') }] })
      continue
    }
    // Some bold text in every paragraph, like real formatted prose.
    content.push({
      type: 'paragraph',
      content: [
        { type: 'text', text: words.slice(0, 10).join(' ') + ' ' },
        { type: 'text', marks: [{ type: 'bold' }], text: words.slice(10, 15).join(' ') },
        { type: 'text', text: ' ' + words.slice(15).join(' ') },
      ],
    })
  }
  return { doc: { type: 'doc', content }, words: n, the: Math.ceil(n / THE_EVERY) }
}

const pct = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]

test('100k-word manuscript: typing latency and Replace All stay within budget', async ({ page, browserName }, testInfo) => {
  test.setTimeout(180_000)
  const { doc, words, the } = buildManuscript()
  expect(words).toBe(WORDS)

  await launch(page)
  await seedProject(page, '/projects/Epic', 'Epic', doc)
  const openStart = Date.now()
  await openRecent(page, '/projects/Epic')
  await expect(saveStatus(page)).toHaveText('Epic: All changes saved', { timeout: 60_000 })
  const openMs = Date.now() - openStart
  const ed = editor(page)
  await expect(ed.locator('p, h2')).toHaveCount(WORDS / WORDS_PER_PARAGRAPH)

  // ---- Typing latency (input-to-paint) in the middle of the manuscript.
  await page.evaluate(() => {
    const w = window as unknown as { __perf: number[] }
    w.__perf = []
    window.addEventListener(
      'keydown',
      (e) => {
        const now = performance.now()
        // Event creation time when it is in the same clock (includes input queueing), else handler time.
        const t0 = e.timeStamp > 0 && e.timeStamp <= now && now - e.timeStamp < 1000 ? e.timeStamp : now
        requestAnimationFrame(() => {
          // A task queued from rAF runs after that frame's style/layout/paint.
          const ch = new MessageChannel()
          ch.port1.onmessage = () => w.__perf.push(performance.now() - t0)
          ch.port2.postMessage(null)
        })
      },
      true,
    )
  })
  await ed.locator('p').nth(500).click()
  await page.keyboard.press('End')
  await page.waitForFunction(() => (window as unknown as { __perf: number[] }).__perf.length >= 1)
  await page.evaluate(() => ((window as unknown as { __perf: number[] }).__perf = []))
  const WARMUP = 5
  const MEASURED = 40
  const typed = 'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do'.slice(0, WARMUP + MEASURED)
  for (const [i, ch] of [...typed].entries()) {
    await page.keyboard.press(ch === ' ' ? 'Space' : ch)
    await page.waitForFunction((k) => (window as unknown as { __perf: number[] }).__perf.length >= k, i + 1)
  }
  const all = await page.evaluate(() => (window as unknown as { __perf: number[] }).__perf)
  const samples = all.slice(WARMUP)
  const sorted = [...samples].sort((a, b) => a - b)
  const typing = {
    keystrokes: samples.length,
    medianMs: +pct(sorted, 50).toFixed(2),
    p95Ms: +pct(sorted, 95).toFixed(2),
    maxMs: +sorted[sorted.length - 1].toFixed(2),
  }
  await expect(ed.locator('p').nth(500)).toContainText(typed)

  // ---- Replace All of a common word.
  await page.keyboard.press('ControlOrMeta+f')
  const panel = page.getByRole('region', { name: 'Find and replace' })
  await panel.getByRole('checkbox', { name: 'Whole word' }).check()
  await panel.getByRole('textbox', { name: 'Find' }).fill('the')
  await expect(page.getByTestId('find-status')).toHaveText(new RegExp(` of ${the}$`), { timeout: 30_000 })
  await panel.getByRole('textbox', { name: 'Replace with' }).fill('a')
  const replaceAllMs = await page.evaluate(async () => {
    const btn = document.querySelector<HTMLButtonElement>('[data-control-id="find.replaceAll"]')!
    const status = document.querySelector('[data-testid="find-status"]')!
    const t0 = performance.now()
    btn.click()
    await new Promise<void>((resolve) => {
      const check = () => (status.textContent?.startsWith('Replaced') ? resolve() : requestAnimationFrame(check))
      check()
    })
    // Include the paint of the result.
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)))
    return performance.now() - t0
  })
  await expect(page.getByTestId('find-status')).toHaveText(`Replaced ${the}`)
  const text = await ed.innerText()
  expect(text).not.toMatch(/\bthe\b/)

  const result = {
    browser: browserName,
    platform: process.platform,
    manuscript: { words, blocks: doc.content.length, occurrencesReplaced: the },
    openMs,
    typing,
    replaceAllMs: +replaceAllMs.toFixed(1),
    budgets: { typingMedianMs: 50, replaceAllMs: 2000 },
    measuredAt: new Date().toISOString(),
  }
  console.info(`[perf] ${JSON.stringify(result)}`)
  mkdirSync('perf-results', { recursive: true })
  writeFileSync(`perf-results/perf-${testInfo.project.name}-${process.platform}.json`, JSON.stringify(result, null, 2))
  await testInfo.attach('perf.json', { body: JSON.stringify(result, null, 2), contentType: 'application/json' })

  expect(typing.keystrokes).toBeGreaterThanOrEqual(20)
  expect(typing.medianMs).toBeLessThan(50)
  expect(replaceAllMs).toBeLessThan(2000)
})
