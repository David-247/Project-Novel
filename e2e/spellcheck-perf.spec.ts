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

/** The text of a fixture block. */
const blockText = (b: Block) => (b.content ?? []).map((r) => r.text ?? '').join('')

/**
 * Corrections the fake tutor lists on one paragraph (`p1`, the first id the chat mints): "teh", and then
 * words that occur once in it (as text, so the guard and the quote check accept each), capitalised.
 */
function correctionsFor(text: string, max: number) {
  const items = [{ paragraph: 'p1', kind: 'spelling', original: 'teh', suggestion: 'the', explanation: 'Two letters swapped.' }]
  for (const w of new Set(text.match(/\b[a-z]{4,}\b/g) ?? [])) {
    if (items.length >= max) break
    if (text.indexOf(w) !== text.lastIndexOf(w)) continue
    items.push({ paragraph: 'p1', kind: 'style', original: w, suggestion: w[0].toUpperCase() + w.slice(1), explanation: 'A capital here.' })
  }
  return items
}

test('100k-word manuscript with spell check on and the tutor open with corrections listed: typing median < 50 ms', async ({ page }, testInfo) => {
  test.setTimeout(240_000)
  const { fx, doc } = misspeltFixture()
  await page.addInitScript(() => {
    ;(window as unknown as { __nvE2EConfig?: Record<string, unknown> }).__nvE2EConfig = {
      tutorConnections: [{ id: 'conn-perf', provider: 'openai', label: 'OpenAI', auth: 'api_key', defaultModel: 'gpt-6.2-sol' }],
    }
  })
  await launch(page)
  await seedProject(page, '/projects/Spelt', 'Spelt', doc)
  await openRecent(page, '/projects/Spelt')
  await expect(saveStatus(page)).toHaveText('Spelt: All changes saved', { timeout: 60_000 })
  await waitForLayout(page)

  // Ask the tutor about a paragraph a third of the way in; it lists corrections on that paragraph.
  const blocks = doc.content as Block[]
  const target = blocks.findIndex((b, i) => i > blocks.length / 3 && b.type === 'paragraph' && i % 5 === 0)
  const items = correctionsFor(blockText(blocks[target]), 15)
  const block = editor(page).locator(':scope > :is(p, h1)').nth(target)
  await clickBlockStart(page, block)
  await waitForLayout(page)
  await block.click({ button: 'right', position: { x: 4, y: 4 } })
  await page.getByRole('menuitem', { name: 'Ask the Tutor About This' }).click()
  const panel = page.getByTestId('tutor-panel')
  await expect(panel).toBeVisible()
  await page.evaluate((list) => window.__nvE2E.tutorQueue([{ text: 'Here is what I found.', tools: [{ name: 'list_corrections', input: { items: list } }] }, { text: 'Apply the ones you agree with.' }]), items)
  const composer = panel.locator('[data-control-id="tutor.composer"]')
  await composer.fill('Check this paragraph.')
  await composer.press('Enter')
  const listed = panel.locator('[data-correction-id]')
  await expect(listed).toHaveCount(items.length, { timeout: 15_000 })
  await expect(panel.getByTestId('tutor-reply').last()).not.toHaveAttribute('data-streaming', 'true')

  // Type in another paragraph two below: every keystroke re-resolves the open corrections.
  const other = editor(page).locator(':scope > :is(p, h1)').nth(target + 2)
  await clickBlockStart(page, other)
  await lineEnd(page)
  await installLatencyProbe(page)
  const typing = await measureTyping(page)
  await expect(other).toContainText(TYPED)
  // The corrections are still open: their paragraph was not touched.
  const states = await listed.evaluateAll((els) => els.map((e) => e.getAttribute('data-state')))
  expect(states.every((s) => s === 'open')).toBe(true)

  await report(testInfo, 'perf-spellcheck-tutor', {
    manuscript: { words: fx.words, blocks: blocks.length },
    corrections: items.length,
    typing,
    budgets: { typingMedianMs: 50 },
  })
  expect(typing.keystrokes).toBeGreaterThanOrEqual(20)
  budget(testInfo, 'typing median ms (100k words, spell check on, tutor open with corrections)', typing.medianMs, 50)
})
