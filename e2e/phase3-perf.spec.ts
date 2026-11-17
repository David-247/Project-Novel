import { expect, test, type Page } from '@playwright/test'
import { budget } from './budget'
import { installLatencyProbe, report } from './perf-helpers'
import { buildPaginationFixture } from './fixtures/pagination-manuscript'
import { clickBlockStart, editor, launch, lineEnd, openRecent, saveStatus, seedProject, waitForLayout, writeFile } from './helpers'

/**
 * Phase 3 acceptance performance (serial perf projects), on the ~100,000-word fixture:
 *  - everything at once: 2,000 tracked changes, 500 comment threads and an open re-write, with
 *    recording on. Typing in the manuscript (keydown -> next frame painted), median < 50 ms; typing in
 *    the open re-write's revision, median < 50 ms;
 *  - large mark-only transactions (review note: they take the pagination engine's incremental path,
 *    unchunked): Select All + Bold on the whole book, the same with recording on (a tracked formatting
 *    change over every block), and Accept All of those. Each from the command to "reflow complete"
 *    (the new page model published and the pages in view painted), < 1 s; all blocks drawn < 3 s.
 * Gating: e2e/budget.ts (decision f040009b). Numbers go to perf-results/phase3-*.json (job summary).
 */

const CHANGED_PARAGRAPHS = 1000 // a deletion and an insertion in each: 2,000 changes
const THREADS = 500
const PASSAGE = 20
const WARMUP = 5
const MEASURED = 40
const TYPED = 'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do'.slice(0, WARMUP + MEASURED)
const pct = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]

type Run = { type: string; text?: string; marks?: unknown[] }
type Block = { type: string; attrs?: Record<string, unknown>; content?: Run[] }

/**
 * The fixture with 2,000 tracked changes (a deleted and an inserted run near the end of 1,000
 * paragraphs), 500 comment threads (on the first word of 500 paragraphs) and a clean run of PASSAGE
 * paragraphs in a chapter past the middle, for the re-write.
 */
function loadedFixture() {
  const fx = buildPaginationFixture()
  const content = fx.doc.content as Block[]
  const headings = content.map((n, i) => (n.type === 'heading' ? i : -1)).filter((i) => i >= 0)
  let passage = -1
  for (const h of headings.slice(Math.floor(headings.length / 2))) {
    const next = headings.find((x) => x > h) ?? content.length
    if (next - h - 2 >= PASSAGE) {
      passage = h + 2
      break
    }
  }
  if (passage < 0) throw new Error('no chapter with enough paragraphs')
  const inPassage = (i: number) => i >= passage - 1 && i < passage + PASSAGE + 1
  const stamp = (id: string) => ({ id, author: 'Ann', date: '2026-01-01T00:00:00.000Z', authorColor: null })
  const words = (r: Run | undefined) => (r?.text ?? '').split(' ').length
  const eligible = content.map((n, i) => [n, i] as const).filter(([n, i]) => n.type === 'paragraph' && !inPassage(i) && words(n.content!.at(-1)) >= 12)
  let changes = 0
  for (const [n, i] of eligible.filter((_, k) => k < eligible.length && k % Math.max(1, Math.floor(eligible.length / CHANGED_PARAGRAPHS)) === 0).slice(0, CHANGED_PARAGRAPHS)) {
    const last = n.content!.at(-1)!
    const w = last.text!.split(' ')
    const cut = w.length - 6
    const keep = last.marks ? { marks: last.marks } : {}
    content[i] = {
      ...n,
      content: [
        ...n.content!.slice(0, -1),
        { type: 'text', text: w.slice(0, cut).join(' ') + ' ', ...keep },
        { type: 'text', text: w.slice(cut, cut + 3).join(' ') + ' ', marks: [...((last.marks as unknown[]) ?? []), { type: 'deletion', attrs: stamp(`d${i}`) }] },
        { type: 'text', text: 'fresh words here ', marks: [...((last.marks as unknown[]) ?? []), { type: 'insertion', attrs: stamp(`i${i}`) }] },
        { type: 'text', text: w.slice(cut + 3).join(' '), ...keep },
      ],
    }
    changes += 2
  }
  const commentable = content.map((n, i) => [n, i] as const).filter(([n, i]) => n.type === 'paragraph' && !inPassage(i) && (n.content?.[0]?.text ?? '').indexOf(' ') > 0 && !n.content![0].marks)
  const step = commentable.length / THREADS
  const threads: unknown[] = []
  for (let k = 0; k < THREADS; k++) {
    const [, i] = commentable[Math.floor(k * step)]
    const node = content[i]
    const first = node.content![0]
    const cut = first.text!.indexOf(' ')
    const id = `t${k}`
    content[i] = { ...node, content: [{ type: 'text', text: first.text!.slice(0, cut), marks: [{ type: 'comment', attrs: { id } }] }, { type: 'text', text: first.text!.slice(cut) }, ...node.content!.slice(1)] }
    const date = new Date(Date.UTC(2026, 10, 1, 0, k)).toISOString()
    threads.push({ id, createdAt: date, author: 'Author', resolved: k % 7 === 0, messages: [{ id: `${id}-1`, author: 'Author', date, text: `Note ${k}: check this.` }] })
  }
  // The typing target: a paragraph mid-book, outside the passage, with a change and no comment.
  const typingAt = eligible.map(([, i]) => i).find((i) => i > content.length / 3 && (content[i].content ?? []).some((r) => JSON.stringify(r.marks ?? []).includes('insertion')))!
  return { fx, doc: { type: 'doc', content }, threads, changes, passage, typingAt }
}

/** Type TYPED one key at a time (each waits for its own frame); the latencies after the warm-up. */
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

/**
 * Run `action` in the page (a registered command, or an e2e hook) and time it to "reflow complete":
 * the new page model published and the pages in view painted; then until every block is drawn.
 */
async function timeToReflow(page: Page, action: { command: string } | { resolveAll: 'accept' }) {
  return page.evaluate(async (a) => {
    const e = window.__nvE2E
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)))
    const v = e.layout().layoutVersion
    const t0 = performance.now()
    if ('command' in a) {
      if (!e.runCommand(a.command)) throw new Error(`${a.command} is disabled`)
    } else e.resolveAllChanges(a.resolveAll)
    const syncMs = performance.now() - t0
    await new Promise<void>((resolve, reject) => {
      const give = setTimeout(() => reject(new Error(`no new layout after ${JSON.stringify(a)}`)), 20_000)
      const check = () => {
        // A pass that leaves every page break where it was publishes no new model: then its end counts.
        const pass = e.paginationLines().lastPass as { startedAt?: number } | null
        if (e.paginationModelSettled() && (e.layout().layoutVersion > v || (pass?.startedAt ?? -1) >= t0)) {
          clearTimeout(give)
          resolve()
        } else requestAnimationFrame(check)
      }
      requestAnimationFrame(check)
    })
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)))
    const ms = performance.now() - t0
    await new Promise<void>((resolve) => {
      const check = () => (e.paginationSettled() ? resolve() : requestAnimationFrame(check))
      check()
    })
    const pass = e.paginationLines().lastPass as { totalMs?: number } | null
    return { syncMs: +syncMs.toFixed(1), ms: +ms.toFixed(1), allDrawnMs: +(performance.now() - t0).toFixed(1), passMs: +(pass?.totalMs ?? -1).toFixed(1), pages: e.layout().pageCount }
  }, action)
}

test('everything at once at 100k words: 2,000 tracked changes, 500 comments, an open re-write, recording on: typing median < 50 ms', async ({ page }, testInfo) => {
  test.setTimeout(300_000)
  const { fx, doc, threads, changes, passage, typingAt } = loadedFixture()
  expect(changes).toBe(2000)
  await launch(page)
  const folder = '/projects/Loaded'
  await seedProject(page, folder, 'Loaded', doc)
  await writeFile(page, `${folder}/comments.json`, JSON.stringify({ version: 1, threads }))
  const t0 = Date.now()
  await openRecent(page, folder)
  await expect(saveStatus(page)).toHaveText('Loaded: All changes saved', { timeout: 60_000 })
  const openMs = Date.now() - t0
  await waitForLayout(page)
  expect(await page.evaluate(() => window.__nvE2E.countChanges())).toBe(2000)
  expect((await page.evaluate(() => window.__nvE2E.comments())).threads).toHaveLength(THREADS)
  await page.evaluate(() => window.__nvE2E.setTracking(true))

  // The re-write: open on the passage, then type in its revision (the view open over the book).
  await editor(page).click()
  await page.evaluate(([a, n]) => {
    const e = window.__nvE2E
    e.selectText(e.blockPos(a) + 2, e.blockPos(a + n - 1) + 2)
  }, [passage, PASSAGE] as const)
  expect(await page.evaluate(() => window.__nvE2E.runCommand('rewrite.open'))).toBe(true)
  const revision = page.getByRole('textbox', { name: 'Revised passage' })
  await expect(revision).toBeFocused()
  await expect.poll(() => page.evaluate(() => window.__nvE2E.rewrite().debug.rows.length)).toBe(PASSAGE)
  await revision.locator('p').nth(8).click()
  await lineEnd(page)
  await installLatencyProbe(page)
  const typingRevision = await measureTyping(page)
  await expect(revision.locator('p').nth(8)).toContainText(TYPED)

  // Close the view: the re-write stays open (its passage locked), and the writer types in the book.
  expect(await page.evaluate(() => window.__nvE2E.runCommand('rewrite.close'))).toBe(true)
  await expect(page.getByTestId('rewrite-view')).toHaveCount(0)
  expect((await page.evaluate(() => window.__nvE2E.rewrite())).rewrites[0].status).toBe('open')
  await expect(editor(page).locator('.nv-rw-locked')).toHaveCount(PASSAGE)
  await waitForLayout(page)
  await clickBlockStart(page, editor(page).locator(':scope > :is(p, h1)').nth(typingAt))
  await lineEnd(page)
  const typing = await measureTyping(page)
  await expect(editor(page).locator(':scope > :is(p, h1)').nth(typingAt)).toContainText(TYPED)
  // Every typed character went in as one tracked insertion.
  expect(await page.evaluate(() => window.__nvE2E.countChanges())).toBe(2001)

  await report(testInfo, 'phase3-combined', {
    manuscript: { words: fx.words, blocks: doc.content.length, changes, threads: THREADS, rewritePassage: PASSAGE },
    openMs,
    typing,
    typingRevision,
    budgets: { typingMedianMs: 50 },
    ciAdvisory: ['typing'],
  })
  expect(typing.keystrokes).toBeGreaterThanOrEqual(20)
  // Typing with recording on is CI-advisory (decision a187e880): reported in CI, blocking locally.
  budget(testInfo, 'typing median ms (tracking on, 2,000 changes, 500 comments, open re-write)', typing.medianMs, 50, { ciAdvisory: true })
  budget(testInfo, 'typing median ms in the open re-write (2,000 changes, 500 comments in the book)', typingRevision.medianMs, 50)
})

test('large mark-only transactions at 100k words: Select All + Bold, tracked, and Accept All: reflow complete < 1 s', async ({ page }, testInfo) => {
  test.setTimeout(300_000)
  const fx = buildPaginationFixture()
  await launch(page)
  await seedProject(page, '/projects/Marks', 'Marks', fx.doc)
  await openRecent(page, '/projects/Marks')
  await expect(saveStatus(page)).toHaveText('Marks: All changes saved', { timeout: 60_000 })
  await waitForLayout(page)
  const pages0 = (await page.evaluate(() => window.__nvE2E.layout())).pageCount

  // Select All + Bold (recording off): one mark step over the whole book.
  await editor(page).click()
  await page.keyboard.press('ControlOrMeta+a')
  const bold = await timeToReflow(page, { command: 'toolbar.bold' })
  await waitForLayout(page)
  expect(await editor(page).locator('strong').count()).toBeGreaterThan(fx.chapters)
  expect(bold.pages).toBeGreaterThan(pages0) // bold text is wider: the book is longer
  // Undo (not timed), then the same with recording on: a tracked formatting change on every block.
  await page.keyboard.press('ControlOrMeta+z')
  await waitForLayout(page)
  expect((await page.evaluate(() => window.__nvE2E.layout())).pageCount).toBe(pages0)
  await page.evaluate(() => window.__nvE2E.setTracking(true))
  await page.keyboard.press('ControlOrMeta+a')
  const tracked = await timeToReflow(page, { command: 'toolbar.bold' })
  await waitForLayout(page)
  const formatChanges = await page.evaluate(() => window.__nvE2E.countChanges())
  expect(formatChanges).toBeGreaterThan(0)
  // Accept All of them: only the formatting-change marks go (the text stays bold).
  const accept = await timeToReflow(page, { resolveAll: 'accept' })
  await waitForLayout(page)
  expect(await page.evaluate(() => window.__nvE2E.countChanges())).toBe(0)
  expect(accept.pages).toBe(tracked.pages)

  await report(testInfo, 'phase3-mark-only', {
    manuscript: { words: fx.words, blocks: fx.doc.content.length, pages: pages0 },
    selectAllBold: bold,
    selectAllBoldTracked: { ...tracked, changes: formatChanges },
    acceptAllFormatting: accept,
    budgets: { reflowMs: 1000, allDrawnMs: 3000 },
  })
  budget(testInfo, 'Select All + Bold: reflow complete ms', bold.ms, 1000)
  budget(testInfo, 'Select All + Bold (tracked): reflow complete ms', tracked.ms, 1000)
  budget(testInfo, `Accept All of ${formatChanges} formatting changes: reflow complete ms`, accept.ms, 1000)
  budget(testInfo, 'Select All + Bold: all blocks drawn ms', bold.allDrawnMs, 3000)
  budget(testInfo, 'Select All + Bold (tracked): all blocks drawn ms', tracked.allDrawnMs, 3000)
  budget(testInfo, 'Accept All formatting changes: all blocks drawn ms', accept.allDrawnMs, 3000)
})
