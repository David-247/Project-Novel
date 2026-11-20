import { expect, test, type Page } from '@playwright/test'
import { budget } from './budget'
import { installLatencyProbe, report } from './perf-helpers'
import { buildPaginationFixture } from './fixtures/pagination-manuscript'
import { clickBlockStart, editor, launch, lineEnd, openRecent, saveStatus, seedProject, waitForLayout } from './helpers'

/**
 * Phase 5 spell check perf (Global Constraints: "Typing stays under 50 ms on the 100k fixture with
 * spell check on"). The ~100,000-word fixture with a misspelling ("teh", flagged by the fake engine)
 * in every fifth paragraph, so the pages in view carry underlines that every keystroke maps. Typing
 * mid-book, keydown to paint, median of 40 keystrokes after 5 warm-up ones, < 50 ms. The check runs
 * 400 ms after the typing pauses, off the keystroke, so this blocks on Windows Chromium CI like plain
 * typing (decision f040009b; it is not CI-advisory, a187e880). Reported: a typed misspelling's time to
 * its underline after the last keystroke, and the engine calls (at most 200 blocks each).
 */

const WARMUP = 5
const MEASURED = 40
const TYPED = 'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do'.slice(0, WARMUP + MEASURED)
const pct = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]

type Run = { type: string; text?: string; marks?: unknown[] }
type Block = { type: string; content?: Run[] }

/** The fixture with " teh" at the end of every fifth paragraph. */
function misspeltFixture() {
  const fx = buildPaginationFixture()
  const content = fx.doc.content as Block[]
  let misspelt = 0
  content.forEach((b, i) => {
    if (b.type !== 'paragraph' || i % 5 !== 0 || !b.content?.length) return
    b.content = [...b.content, { type: 'text', text: ' teh' }]
    misspelt++
  })
  return { fx, doc: { type: 'doc', content }, misspelt }
}

async function measureTyping(page: Page) {
  await page.evaluate(() => ((window as unknown as { __perf: number[] }).__perf = []))
  for (const [i, ch] of [...TYPED].entries()) {
    await page.keyboard.press(ch === ' ' ? 'Space' : ch)
    await page.waitForFunction((k) => (window as unknown as { __perf: number[] }).__perf.length >= k, i + 1)
  }
  const all = await page.evaluate(() => (window as unknown as { __perf: number[] }).__perf)
  const sorted = all.slice(WARMUP).sort((a, b) => a - b)
  return { keystrokes: sorted.length, medianMs: +pct(sorted, 50).toFixed(2), p95Ms: +pct(sorted, 95).toFixed(2), maxMs: +sorted[sorted.length - 1].toFixed(2) }
}

test('100k-word manuscript with spell check on: typing median < 50 ms; underlines follow after the pause', async ({ page }, testInfo) => {
  test.setTimeout(240_000)
  const { fx, doc, misspelt } = misspeltFixture()
  await launch(page)
  await seedProject(page, '/projects/Spelt', 'Spelt', doc)
  const t0 = Date.now()
  await openRecent(page, '/projects/Spelt')
  await expect(saveStatus(page)).toHaveText('Spelt: All changes saved', { timeout: 60_000 })
  const openMs = Date.now() - t0
  await waitForLayout(page)
  expect(await page.evaluate(() => window.__nvE2E.preferences().spellcheck.enabled)).toBe(true)

  // A paragraph a third of the way in, holding a misspelling: its page shows underlines.
  const target = (doc.content as Block[]).findIndex((b, i) => i > doc.content.length / 3 && b.type === 'paragraph' && i % 5 === 0)
  const block = editor(page).locator(':scope > :is(p, h1)').nth(target)
  await clickBlockStart(page, block)
  await waitForLayout(page)
  await expect(block.locator('.spell-error')).toHaveText(['teh'], { timeout: 15_000 })
  const underlinedInView = await editor(page).locator('.spell-error').count()
  expect(underlinedInView).toBeGreaterThan(0)
  // Only the pages around the view were checked, never the book.
  expect(underlinedInView).toBeLessThan(misspelt)

  await lineEnd(page)
  await installLatencyProbe(page)
  await page.evaluate(() => (window.__nvE2E.spell.calls.length = 0))
  const typing = await measureTyping(page)
  await expect(block).toContainText(TYPED)
  // While the keys came faster than the 400 ms pause, the engine was never called.
  const callsWhileTyping = await page.evaluate(() => window.__nvE2E.spell.calls.length)

  // A typed misspelling: from the last keystroke to its underline (the pause plus the check).
  await page.keyboard.type(' teh')
  const typedAt = await page.evaluate(() => performance.now())
  await page.keyboard.press('Space')
  await expect(block.locator('.spell-error')).toHaveText(['teh', 'teh'], { timeout: 10_000 })
  const underlineMs = +((await page.evaluate(() => performance.now())) - typedAt).toFixed(1)
  const calls = await page.evaluate(() => window.__nvE2E.spell.calls.map((c) => c.blocks.length))

  const result = {
    manuscript: { words: fx.words, blocks: doc.content.length, misspelt },
    openMs,
    typing,
    spellcheck: {
      underlineMs,
      engineCalls: calls.length,
      maxBlocksPerCall: Math.max(0, ...calls),
      blocksChecked: calls.reduce((a, b) => a + b, 0),
      callsWhileTyping,
      underlinedInView,
    },
    budgets: { typingMedianMs: 50 },
  }
  await report(testInfo, 'perf-spellcheck', result)
  expect(typing.keystrokes).toBeGreaterThanOrEqual(20)
  expect(Math.max(0, ...calls)).toBeLessThanOrEqual(200)
  budget(testInfo, 'typing median ms (100k words, spell check on)', typing.medianMs, 50)
})
