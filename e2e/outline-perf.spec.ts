import { expect, test, type Page } from '@playwright/test'
import { budget } from './budget'
import { installLatencyProbe, report } from './perf-helpers'
import { clickBlockStart, editor, launch, lineEnd, openRecent, saveStatus, seedProject, waitForLayout } from './helpers'

/**
 * Phase 4 navigation pane perf (ticket 316a21b5): typing on a 100,000-word manuscript with the pane
 * open (40 chapters, 40 subheadings, every row with live word and page counts) stays under 50 ms,
 * keydown to paint, median of 40 keystrokes after 5 warm-up ones. The pane rebuilds its tree in idle
 * time after each word count publish (throttled by the editor slice), never on the keystroke, so this
 * blocks on Windows Chromium CI like plain typing (decision f040009b; plain typing is not CI-advisory,
 * a187e880). The time from the last keystroke to the row showing its new count is reported.
 */

const WORDS = 100_000
const WORDS_PER_PARAGRAPH = 100
const VOCAB = [
  'night', 'river', 'quiet', 'lantern', 'stone', 'window', 'garden', 'letter', 'morning', 'shadow',
  'silver', 'harbor', 'whisper', 'meadow', 'candle', 'thunder', 'orchard', 'ribbon', 'compass', 'feather',
]
const WARMUP = 5
const MEASURED = 40
const TYPED = 'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do'.slice(0, WARMUP + MEASURED)
const CHAPTER_EVERY = 25

/** 1,000 blocks: a chapter title every 25 blocks, a subheading half-way through each chapter. */
function buildManuscript() {
  let n = 0
  const word = () => VOCAB[(n++ * 7) % VOCAB.length]
  const content: unknown[] = []
  for (let p = 0; n < WORDS; p++) {
    const words = Array.from({ length: Math.min(WORDS_PER_PARAGRAPH, WORDS - n) }, word)
    if (p % CHAPTER_EVERY === 0) {
      content.push({ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: words.join(' ') }] })
      continue
    }
    if (p % CHAPTER_EVERY === 12) {
      content.push({ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: words.join(' ') }] })
      continue
    }
    content.push({
      type: 'paragraph',
      content: [
        { type: 'text', text: words.slice(0, 10).join(' ') + ' ' },
        { type: 'text', marks: [{ type: 'bold' }], text: words.slice(10, 15).join(' ') },
        { type: 'text', text: ' ' + words.slice(15).join(' ') },
      ],
    })
  }
  return { doc: { type: 'doc', content }, words: n }
}

const pct = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]

async function measureTyping(page: Page, paragraph: number) {
  const ed = editor(page)
  await clickBlockStart(page, ed.locator('p').nth(paragraph))
  await lineEnd(page)
  await page.waitForFunction(() => (window as unknown as { __perf: number[] }).__perf.length >= 1)
  await page.evaluate(() => ((window as unknown as { __perf: number[] }).__perf = []))
  for (const [i, ch] of [...TYPED].entries()) {
    await page.keyboard.press(ch === ' ' ? 'Space' : ch)
    await page.waitForFunction((k) => (window as unknown as { __perf: number[] }).__perf.length >= k, i + 1)
  }
  const samples = (await page.evaluate(() => (window as unknown as { __perf: number[] }).__perf)).slice(WARMUP)
  const sorted = [...samples].sort((a, b) => a - b)
  await expect(ed.locator('p').nth(paragraph)).toContainText(TYPED)
  return { keystrokes: samples.length, medianMs: +pct(sorted, 50).toFixed(2), p95Ms: +pct(sorted, 95).toFixed(2), maxMs: +sorted[sorted.length - 1].toFixed(2) }
}

test('100k-word manuscript with the navigation pane open: typing stays within budget and the counts follow', async ({ page }, testInfo) => {
  test.setTimeout(180_000)
  const { doc, words } = buildManuscript()
  await launch(page)
  await seedProject(page, '/projects/Outlined', 'Outlined', doc)
  const openStart = Date.now()
  await openRecent(page, '/projects/Outlined')
  await expect(saveStatus(page)).toHaveText('Outlined: All changes saved', { timeout: 60_000 })
  const openMs = Date.now() - openStart
  await waitForLayout(page)
  await expect(page.getByTestId('word-count')).toHaveText('100,000 words', { timeout: 30_000 })

  await page.keyboard.press('ControlOrMeta+Shift+O')
  const chapters = WORDS / WORDS_PER_PARAGRAPH / CHAPTER_EVERY
  await expect(page.getByRole('treeitem')).toHaveCount(chapters * 2, { timeout: 30_000 })
  await expect(page.getByTestId('outline-total')).toContainText('100,000 words')

  // Paragraph 500 is in chapter 21 (each chapter: 1 title + 1 subheading + 23 paragraphs).
  const paragraph = 500
  const chapterIndex = Math.floor(paragraph / (CHAPTER_EVERY - 2))
  const rowCounts = page.locator(`[role="treeitem"][data-outline-key="ch:${chapterIndex}"] [data-outline-counts]`)
  const wordsOf = async () => Number((await rowCounts.textContent())!.match(/^([\d,]+)/)![1].replace(/,/g, ''))
  const before = await wordsOf()
  await installLatencyProbe(page)
  const typing = await measureTyping(page, paragraph)
  // TYPED runs on from the paragraph's last word: its first word joins that one.
  const added = TYPED.trim().split(/\s+/).length - 1
  const t0 = Date.now()
  await expect.poll(wordsOf, { timeout: 10_000 }).toBe(before + added)
  const caughtUpMs = Date.now() - t0
  await expect(page.getByTestId('outline-total')).toContainText(`${(words + added).toLocaleString('en-US')} words`)

  await report(testInfo, 'perf-navigation-pane', {
    manuscript: { words, blocks: doc.content.length, chapters, subheadings: chapters },
    openMs,
    typing,
    outline: { caughtUpMs, rows: chapters * 2, lastBuildMs: await page.evaluate(() => window.__nvE2E.outlineBuildMs()) },
    budgets: { typingMedianMs: 50 },
  })
  expect(typing.keystrokes).toBeGreaterThanOrEqual(20)
  budget(testInfo, 'typing median ms (navigation pane open)', typing.medianMs, 50)
})
