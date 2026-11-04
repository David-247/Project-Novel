import { mkdirSync, writeFileSync } from 'node:fs'
import { expect, test, type Page, type TestInfo } from '@playwright/test'
import { budget } from './budget'
import { clickBlockStart, editor, launch, lineEnd, openRecent, readFile, saveStatus, seedProject, waitForLayout } from './helpers'

/**
 * Performance budget on a 100,000-word manuscript, in real browser engines
 * (chromium ~ WebView2, webkit ~ WKWebView):
 *  - typing latency: keydown -> next animation frame -> after that frame (input-to-paint),
 *    median < 50 ms over 40 measured keystrokes (5 warm-up keystrokes discarded); p95 reported;
 *  - Replace All of a common word: click -> "Replaced N" shown and painted, < 2 s;
 *  - combined hot path: typing with the find panel open on "the" (10,000 live matches) while an
 *    autosave snapshot is forced mid-typing; median < 50 ms; p95 reported, not asserted.
 * Numbers are written to perf-results/*.json (CI artifact + job summary) and attached to the report.
 */

const WORDS = 100_000
const WORDS_PER_PARAGRAPH = 100
const VOCAB = [
  'night', 'river', 'quiet', 'lantern', 'stone', 'window', 'garden', 'letter', 'morning', 'shadow',
  'silver', 'harbor', 'whisper', 'meadow', 'candle', 'thunder', 'orchard', 'ribbon', 'compass', 'feather',
]
/** Every 10th word is "the": 10,000 occurrences to replace. */
const THE_EVERY = 10
const WARMUP = 5
const MEASURED = 40
const TYPED = 'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do'.slice(0, WARMUP + MEASURED)

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

/** Launch, open the 100k-word project from Open Recent; returns the open time. */
async function openEpic(page: Page, folder: string, doc: unknown, blocks = 'p, h2'): Promise<number> {
  await launch(page)
  const title = folder.split('/').pop()!
  await seedProject(page, folder, title, doc)
  const openStart = Date.now()
  await openRecent(page, folder)
  await expect(saveStatus(page)).toHaveText(`${title}: All changes saved`, { timeout: 60_000 })
  const openMs = Date.now() - openStart
  await expect(editor(page).locator(blocks)).toHaveCount(WORDS / WORDS_PER_PARAGRAPH)
  // The opened book is laid out progressively (pages in view first): wait until every block is at its
  // page before clicking text by its painted position.
  await waitForLayout(page)
  return openMs
}

/** Input-to-paint probe: keydown -> next animation frame -> a task after that frame. */
async function installLatencyProbe(page: Page) {
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
}

/**
 * Put the caret at the end of paragraph 500 (mid-manuscript), type WARMUP + MEASURED characters one
 * at a time (each waits for its own paint), and summarize the measured ones. `beforeKey(i)` runs just
 * before keystroke i.
 */
async function measureTyping(page: Page, beforeKey?: (i: number) => Promise<void>) {
  const ed = editor(page)
  // On the painted text (paged view: a block's box is not where all its lines are painted).
  await clickBlockStart(page, ed.locator('p').nth(500))
  await lineEnd(page)
  await page.waitForFunction(() => (window as unknown as { __perf: number[] }).__perf.length >= 1)
  await page.evaluate(() => ((window as unknown as { __perf: number[] }).__perf = []))
  for (const [i, ch] of [...TYPED].entries()) {
    await beforeKey?.(i)
    await page.keyboard.press(ch === ' ' ? 'Space' : ch)
    await page.waitForFunction((k) => (window as unknown as { __perf: number[] }).__perf.length >= k, i + 1)
  }
  const all = await page.evaluate(() => (window as unknown as { __perf: number[] }).__perf)
  const samples = all.slice(WARMUP)
  const sorted = [...samples].sort((a, b) => a - b)
  await expect(ed.locator('p').nth(500)).toContainText(TYPED)
  return {
    keystrokes: samples.length,
    medianMs: +pct(sorted, 50).toFixed(2),
    p95Ms: +pct(sorted, 95).toFixed(2),
    maxMs: +sorted[sorted.length - 1].toFixed(2),
  }
}

async function report(testInfo: TestInfo, name: string, result: Record<string, unknown>) {
  const full = { scenario: name, browser: testInfo.project.name, platform: process.platform, ...result, measuredAt: new Date().toISOString() }
  console.info(`[perf] ${JSON.stringify(full)}`)
  mkdirSync('perf-results', { recursive: true })
  writeFileSync(`perf-results/${name}-${testInfo.project.name}-${process.platform}.json`, JSON.stringify(full, null, 2))
  await testInfo.attach(`${name}.json`, { body: JSON.stringify(full, null, 2), contentType: 'application/json' })
}

const findPanel = (page: Page) => page.getByRole('region', { name: 'Find and replace' })

/** Open the find panel on whole-word "the" and wait until all `the` matches are counted. */
async function findThe(page: Page, the: number) {
  await page.keyboard.press('ControlOrMeta+f')
  const panel = findPanel(page)
  await panel.getByRole('checkbox', { name: 'Whole word' }).check()
  await panel.getByRole('textbox', { name: 'Find' }).fill('the')
  await expect(page.getByTestId('find-status')).toHaveText(new RegExp(` of ${the}$`), { timeout: 30_000 })
}

test('100k-word manuscript: typing latency and Replace All stay within budget', async ({ page }, testInfo) => {
  test.setTimeout(180_000)
  const { doc, words, the } = buildManuscript()
  expect(words).toBe(WORDS)

  const openMs = await openEpic(page, '/projects/Epic', doc)
  await installLatencyProbe(page)
  const typing = await measureTyping(page)

  // ---- Replace All of a common word.
  await findThe(page, the)
  await findPanel(page).getByRole('textbox', { name: 'Replace with' }).fill('a')
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
  const text = await editor(page).innerText()
  expect(text).not.toMatch(/\bthe\b/)

  await report(testInfo, 'perf', {
    manuscript: { words, blocks: doc.content.length, occurrencesReplaced: the },
    openMs,
    typing,
    replaceAllMs: +replaceAllMs.toFixed(1),
    budgets: { typingMedianMs: 50, replaceAllMs: 2000 },
  })

  expect(typing.keystrokes).toBeGreaterThanOrEqual(20)
  budget(testInfo, 'typing median ms', typing.medianMs, 50)
  budget(testInfo, 'Replace All ms', replaceAllMs, 2000)
})

test('100k-word manuscript, combined hot path: find panel open on "the" + autosave mid-typing', async ({ page }, testInfo) => {
  test.setTimeout(180_000)
  const { doc, words, the } = buildManuscript()
  const folder = '/projects/Hot'
  const openMs = await openEpic(page, folder, doc)

  // 10,000 live matches highlighted while typing.
  await findThe(page, the)
  await installLatencyProbe(page)

  // Halfway through the measured keystrokes, force an autosave snapshot (serializes the whole
  // document) without waiting for it, so it competes with the next keystrokes like the 30 s timer.
  const autosaveAt = WARMUP + Math.floor(MEASURED / 2)
  const typing = await measureTyping(page, async (i) => {
    if (i === autosaveAt) {
      await page.evaluate(() => {
        void window.__nvE2E.autosaveNow()
      })
    }
  })

  // The panel stayed open and still counts the matches; the snapshot really was written.
  await expect(findPanel(page)).toBeVisible()
  await expect(page.getByTestId('find-status')).toHaveText(new RegExp(` of ${the}$`))
  await expect.poll(() => readFile(page, `${folder}/.recovery/manuscript.json`)).not.toBeNull()
  const snapshot = JSON.parse((await readFile(page, `${folder}/.recovery/manuscript.json`))!)
  expect(JSON.stringify(snapshot.doc)).toContain(TYPED.slice(0, autosaveAt))

  await report(testInfo, 'perf-hotpath', {
    manuscript: { words, blocks: doc.content.length, liveMatches: the },
    openMs,
    autosaveForcedBeforeKeystroke: autosaveAt + 1,
    typing,
    budgets: { typingMedianMs: 50 },
  })

  expect(typing.keystrokes).toBeGreaterThanOrEqual(20)
  budget(testInfo, 'typing median ms (hot path)', typing.medianMs, 50)
})

test('100k-word manuscript: changing the Chapter Title font size restyles every chapter in < 100 ms and repaginates in < 1 s, no doc change', async ({ page }, testInfo) => {
  test.setTimeout(180_000)
  const built = buildManuscript()
  // Chapter Title applied to every chapter heading (40 chapters).
  const content = (built.doc.content as Array<{ type: string; attrs?: Record<string, unknown> }>).map((b) =>
    b.type === 'heading' ? { ...b, attrs: { level: 1, styleId: 'chapter-title' } } : b,
  )
  const doc = { type: 'doc', content }
  const chapters = content.filter((b) => b.type === 'heading').length
  const openMs = await openEpic(page, '/projects/Styled', doc, 'p, h1')
  const titles = page.locator('main [contenteditable="true"] h1[data-style="chapter-title"]')
  await expect(titles).toHaveCount(chapters)

  await titles.nth(chapters - 1).click()
  await page.locator('[data-control-id="styles.edit"]').click()
  const dialog = page.getByRole('dialog', { name: 'Modify style: Chapter Title' })
  await dialog.locator('[data-control-id="styles.field.fontSize"]').fill('28')
  const versionBefore = await page.evaluate(() => window.__nvE2E.docVersion())

  const result = await page.evaluate(async () => {
    const all = Array.from(document.querySelectorAll<HTMLElement>('main [contenteditable="true"] h1[data-style="chapter-title"]'))
    const before = all.map((el) => getComputedStyle(el).fontSize)
    const last = all[all.length - 1]
    const save = document.querySelector<HTMLButtonElement>('[data-control-id="styles.modify.save"]')!
    const v = window.__nvE2E.layout().layoutVersion
    const t0 = performance.now()
    save.click()
    // 1. The style sheet swap: React commits the new sheet within the click's task / microtasks.
    //    Read it and force layout before any animation frame, i.e. before pagination runs.
    let microtasks = 0
    while (getComputedStyle(last).fontSize === before[before.length - 1] && microtasks++ < 50) await Promise.resolve()
    const swapped = getComputedStyle(last).fontSize !== before[before.length - 1]
    void document.body.offsetHeight
    const cssMs = performance.now() - t0
    // 2. Repagination, "reflow complete" (docs/pagination.md): the engine re-measured the restyled
    //    blocks, published the new page model, and drew and painted the pages in view.
    await new Promise<void>((resolve) => {
      const check = () =>
        window.__nvE2E.paginationModelSettled() && window.__nvE2E.layout().layoutVersion > v ? resolve() : requestAnimationFrame(check)
      requestAnimationFrame(check)
    })
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)))
    const repaginatedMs = performance.now() - t0
    // Off-screen blocks follow in later frames: reported.
    await new Promise<void>((resolve) => {
      const check = () => (window.__nvE2E.paginationSettled() ? resolve() : requestAnimationFrame(check))
      check()
    })
    const allDrawnMs = performance.now() - t0
    const changed = all.filter((el, i) => getComputedStyle(el).fontSize !== before[i]).length
    return { cssMs, swapped, repaginatedMs, allDrawnMs, changed }
  })
  const versionAfter = await page.evaluate(() => window.__nvE2E.docVersion())

  await report(testInfo, 'perf-styles', {
    manuscript: { words: built.words, blocks: content.length, chapters },
    openMs,
    restyleMs: +result.cssMs.toFixed(1),
    repaginatedMs: +result.repaginatedMs.toFixed(1),
    allDrawnMs: +result.allDrawnMs.toFixed(1),
    chaptersRestyled: result.changed,
    docVersionChanged: versionAfter !== versionBefore,
    // The style sheet swap keeps the styles budget; the reflow it causes in the paginated view
    // (every page break can move) gets the reflow budget, like a trim change (docs/pagination.md).
    budgets: { restyleMs: 100, repaginatedMs: 1000, allDrawnMs: 3000 },
  })

  expect(result.swapped).toBe(true)
  expect(result.changed).toBe(chapters)
  expect(versionAfter).toBe(versionBefore)
  budget(testInfo, 'restyle style sheet swap ms', result.cssMs, 100)
  budget(testInfo, 'restyle reflow complete ms', result.repaginatedMs, 1000)
  budget(testInfo, 'restyle all drawn ms', result.allDrawnMs, 3000)
})

/**
 * The 100k-word manuscript with a footnote after the bold words of every 4th paragraph (200 in all;
 * paragraph 500 has one, so every keystroke re-measures a block holding a reference and re-reserves
 * its page).
 */
function buildFootnotedManuscript() {
  const built = buildManuscript()
  let notes = 0
  let paragraph = 0
  const content = (built.doc.content as Array<{ type: string; content?: unknown[] }>).map((b) => {
    if (b.type !== 'paragraph') return b
    const withNote = paragraph++ % 4 === 0 && notes < 200
    if (!withNote) return b
    notes++
    const note = { type: 'footnote', content: [{ type: 'text', text: `Note ${notes}: ${VOCAB.slice(0, 6 + (notes % 12)).join(' ')}.` }] }
    return { ...b, content: [...b.content!.slice(0, 2), note, ...b.content!.slice(2)] }
  })
  return { ...built, content, notes }
}

test('100k-word manuscript with 200 footnotes: typing in the main text stays within budget', async ({ page }, testInfo) => {
  test.setTimeout(180_000)
  const { content, notes, ...built } = buildFootnotedManuscript()
  expect(notes).toBe(200)
  const doc = { type: 'doc', content }
  const openMs = await openEpic(page, '/projects/Footnoted', doc)
  await expect(page.locator('main [contenteditable="true"] [data-footnote-ref]')).toHaveCount(200)
  // Footnote areas are drawn for the pages in view.
  await expect(page.locator('.nv-fn-area').first()).toBeVisible()
  await installLatencyProbe(page)
  const typing = await measureTyping(page)
  const pass = await page.evaluate(() => window.__nvE2E.paginationLines().lastPass)

  await report(testInfo, 'perf-footnotes', {
    manuscript: { words: built.words, blocks: content.length, footnotes: notes },
    openMs,
    typing,
    lastPass: pass,
    budgets: { typingMedianMs: 50 },
  })

  expect(typing.keystrokes).toBeGreaterThanOrEqual(20)
  budget(testInfo, 'typing median ms (200 footnotes)', typing.medianMs, 50)
})

test('100k-word manuscript, paginated combined hot path: spread view + 200 footnotes + find open + autosave mid-typing', async ({ page }, testInfo) => {
  test.setTimeout(240_000)
  // A window wide enough for the two-page spread at Fit spread (the default view).
  await page.setViewportSize({ width: 1400, height: 900 })
  const { content, notes, words } = buildFootnotedManuscript()
  const doc = { type: 'doc', content }
  const folder = '/projects/Combined'
  const openMs = await openEpic(page, folder, doc)
  expect((await page.evaluate(() => window.__nvE2E.layout())).effectiveView).toBe('spread')
  await expect(page.locator('main [contenteditable="true"] [data-footnote-ref]')).toHaveCount(notes)
  await expect(page.locator('.nv-fn-area').first()).toBeVisible()

  // Find panel open on whole-word "the": 10,000 live matches (plus any in the notes' text).
  await page.keyboard.press('ControlOrMeta+f')
  const panel = findPanel(page)
  await panel.getByRole('checkbox', { name: 'Whole word' }).check()
  await panel.getByRole('textbox', { name: 'Find' }).fill('the')
  await expect(page.getByTestId('find-status')).toHaveText(/ of \d+$/, { timeout: 30_000 })
  const matches = Number((await page.getByTestId('find-status').textContent())!.match(/ of (\d+)$/)![1])
  expect(matches).toBeGreaterThanOrEqual(10_000)
  await installLatencyProbe(page)

  // Autosave forced halfway through the measured keystrokes, not awaited (competes like the timer).
  const autosaveAt = WARMUP + Math.floor(MEASURED / 2)
  const typing = await measureTyping(page, async (i) => {
    if (i === autosaveAt) {
      await page.evaluate(() => {
        void window.__nvE2E.autosaveNow()
      })
    }
  })
  await waitForLayout(page)
  const after = await page.evaluate(() => window.__nvE2E.layout())

  await expect(findPanel(page)).toBeVisible()
  await expect.poll(() => readFile(page, `${folder}/.recovery/manuscript.json`)).not.toBeNull()
  const snapshot = JSON.parse((await readFile(page, `${folder}/.recovery/manuscript.json`))!)
  expect(JSON.stringify(snapshot.doc)).toContain(TYPED.slice(0, autosaveAt))
  expect(after.effectiveView).toBe('spread')

  await report(testInfo, 'perf-combined', {
    manuscript: { words, blocks: content.length, footnotes: notes, liveMatches: matches },
    view: after.effectiveView,
    pages: after.pageCount,
    openMs,
    autosaveForcedBeforeKeystroke: autosaveAt + 1,
    typing,
    budgets: { typingMedianMs: 50 },
  })

  expect(typing.keystrokes).toBeGreaterThanOrEqual(20)
  budget(testInfo, 'typing median ms (paginated combined hot path)', typing.medianMs, 50)
})
