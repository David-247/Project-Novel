import { expect, test, type Page } from '@playwright/test'
import { budget } from './budget'
import { installLatencyProbe, report } from './perf-helpers'
import { buildPaginationFixture } from './fixtures/pagination-manuscript'
import { clickBlockStart, editor, launch, lineEnd, openRecent, saveStatus, seedProject, waitForLayout, writeFile, reveal } from './helpers'

/**
 * Comments performance (serial perf projects, like pagination-perf.spec.ts): the 100,000-word
 * manuscript with 500 comment threads.
 *  - typing latency (keydown -> next frame painted), median < 50 ms;
 *  - margin panel re-layout after a reflow (a trim size change): from the new page model being published
 *    to the visible spread's cards rendered and positioned, < 100 ms (publish to painted is reported only).
 * Gating: e2e/budget.ts (decision f040009b). Numbers go to perf-results/comments-*.json.
 */

const THREADS = 500
const WARMUP = 5
const MEASURED = 40
const TYPED = 'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do'.slice(0, WARMUP + MEASURED)
const pct = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]

type Node = { type: string; content?: Node[]; text?: string; marks?: unknown[] }

/** The pagination fixture with a comment on the first word of THREADS paragraphs spread evenly (the first one included). */
function commentedFixture() {
  const fx = buildPaginationFixture()
  const content = fx.doc.content as Node[]
  const paragraphs = content.map((n, i) => [n, i] as const).filter(([n]) => n.type === 'paragraph' && n.content?.[0]?.type === 'text')
  const step = paragraphs.length / THREADS
  const threads: unknown[] = []
  for (let k = 0; k < THREADS; k++) {
    const [node, index] = paragraphs[Math.floor(k * step)]
    const first = node.content![0]
    const cut = first.text!.indexOf(' ')
    if (cut <= 0) continue
    const id = `t${k}`
    const marks = [...((first.marks as unknown[]) ?? []), { type: 'comment', attrs: { id } }]
    content[index] = {
      ...node,
      content: [{ ...first, text: first.text!.slice(0, cut), marks }, { ...first, text: first.text!.slice(cut) }, ...node.content!.slice(1)],
    }
    const date = new Date(Date.UTC(2026, 10, 1, 0, k)).toISOString()
    threads.push({
      id,
      createdAt: date,
      author: 'Author',
      resolved: k % 7 === 0,
      messages: [
        { id: `${id}-1`, author: 'Author', date, text: `Note ${k}: check this.` },
        ...(k % 3 === 0 ? [{ id: `${id}-2`, author: 'Editor', date, text: 'A reply\nover two lines.' }] : []),
      ],
    })
  }
  return { fx, doc: { type: 'doc', content }, threads }
}

async function openFixture(page: Page, folder: string) {
  const { fx, doc, threads } = commentedFixture()
  await launch(page)
  const title = folder.split('/').pop()!
  await seedProject(page, folder, title, doc)
  await writeFile(page, `${folder}/comments.json`, JSON.stringify({ version: 1, threads }))
  await openRecent(page, folder)
  await expect(saveStatus(page)).toHaveText(`${title}: All changes saved`, { timeout: 60_000 })
  await waitForLayout(page)
  expect((await page.evaluate(() => window.__nvE2E.comments())).threads).toHaveLength(threads.length)
  await expect(page.locator('[data-testid="comments-panel"] article[data-thread-id]').first()).toBeVisible()
  return { fx, threads: threads.length }
}

test('500 comment threads at 100k words: typing median < 50 ms', async ({ page }, testInfo) => {
  test.setTimeout(180_000)
  const { fx, threads } = await openFixture(page, '/projects/CommentTyping')
  const ed = editor(page)
  await installLatencyProbe(page)
  // End of the first line of a mid-manuscript paragraph, with comments on the spread in view.
  await clickBlockStart(page, ed.locator('p').nth(Math.floor((await ed.locator('p').count()) / 2)))
  await page.evaluate(() => ((window as unknown as { __perf: number[] }).__perf = []))
  await lineEnd(page)
  await page.waitForFunction(() => (window as unknown as { __perf: number[] }).__perf.length >= 1)
  await page.evaluate(() => ((window as unknown as { __perf: number[] }).__perf = []))
  for (const [i, ch] of [...TYPED].entries()) {
    await page.keyboard.press(ch === ' ' ? 'Space' : ch)
    await page.waitForFunction((k) => (window as unknown as { __perf: number[] }).__perf.length >= k, i + 1)
  }
  const all = await page.evaluate(() => (window as unknown as { __perf: number[] }).__perf)
  const sorted = all.slice(WARMUP).sort((a, b) => a - b)
  const typing = { keystrokes: sorted.length, medianMs: +pct(sorted, 50).toFixed(2), p95Ms: +pct(sorted, 95).toFixed(2), maxMs: +sorted[sorted.length - 1].toFixed(2) }
  await waitForLayout(page)
  const cardsInView = await page.locator('[data-testid="comments-panel"] article[data-thread-id]').count()
  await report(testInfo, 'comments-typing', { manuscript: { words: fx.words, blocks: fx.doc.content.length }, threads, cardsInView, typing, budgets: { typingMedianMs: 50 } })
  expect(typing.keystrokes).toBeGreaterThanOrEqual(20)
  budget(testInfo, 'typing median ms (500 comments)', typing.medianMs, 50)
})

test('500 comment threads: margin panel re-layout after a reflow < 100 ms', async ({ page }, testInfo) => {
  test.setTimeout(180_000)
  const { threads } = await openFixture(page, '/projects/CommentLayout')
  await page.evaluate(() => window.__nvE2E.watchLayoutPublishes())
  const runs: { trim: string; panelReadyMs: number; panelCommitMs: number; fromFirstPublishMs: number; versions: number; positionMs: number; reflowToPanelMs: number; cards: number; misplaced: number; sameFrame: boolean }[] = []
  for (const trim of ['us-6x9', 'uk-a5', 'us-5.5x8.5']) {
    const r = await page.evaluate(async (id) => {
      const v0 = window.__nvE2E.layout().layoutVersion
      const t0 = performance.now()
      window.__nvE2E.setTrimSize(id)
      // The next frame, before it paints: are the cards already positioned for the published layout?
      const firstFrame = await new Promise<{ laidOut: number; published: number }>((resolve) =>
        requestAnimationFrame(() => resolve({ laidOut: window.__nvE2E.comments().layout.laidOutVersion, published: window.__nvE2E.layout().layoutVersion })),
      )
      // The visible spread's cards rendered and positioned for the published layout ...
      await new Promise<void>((resolve) => {
        const check = () => {
          const l = window.__nvE2E.layout()
          const c = window.__nvE2E.comments().layout
          if (window.__nvE2E.paginationModelSettled() && l.layoutVersion > v0 && c.laidOutVersion >= l.layoutVersion) resolve()
          else requestAnimationFrame(check)
        }
        check()
      })
      // ... and painted (the frame after the commit).
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => {
          const ch = new MessageChannel()
          ch.port1.onmessage = () => resolve()
          ch.port2.postMessage(null)
        }),
      )
      const paintedAt = performance.now()
      const c = window.__nvE2E.comments().layout
      // Publish times of the first model after the change and of the one the panel laid out for.
      const firstPublishedAt = window.__nvE2E.layoutPublishedAt(v0 + 1) ?? t0
      const publishedAt = window.__nvE2E.layoutPublishedAt(c.laidOutVersion) ?? firstPublishedAt
      // Every card shown is level with its anchor or below the card above it (positioned, not stale).
      const box = document.querySelector('[data-testid="comment-cards"]')!.getBoundingClientRect()
      let misplaced = 0
      let prevBottom = -Infinity
      for (const slot of Array.from(document.querySelectorAll<HTMLElement>('.nv-comment-slot'))) {
        const anchor = document.querySelector(`.novel-editor-content [data-comment-id="${slot.dataset.slot}"]`)?.getClientRects()[0]
        const top = box.top + Number(slot.dataset.top)
        // Stacked below the card above it, never above its own anchor line.
        if (!anchor || top < prevBottom - 1 || top < anchor.top - 2) misplaced++
        prevBottom = top + slot.offsetHeight
      }
      return {
        panelReadyMs: paintedAt - publishedAt,
        panelCommitMs: c.laidOutAt - publishedAt,
        fromFirstPublishMs: paintedAt - firstPublishedAt,
        versions: c.laidOutVersion - v0,
        sameFrame: firstFrame.published > v0 && firstFrame.laidOut >= firstFrame.published,
        positionMs: window.__nvE2E.comments().layout.lastLayoutMs,
        reflowToPanelMs: paintedAt - t0,
        cards: document.querySelectorAll('[data-testid="comments-panel"] article[data-thread-id]').length,
        misplaced,
      }
    }, trim)
    runs.push({ trim, panelReadyMs: +r.panelReadyMs.toFixed(1), panelCommitMs: +r.panelCommitMs.toFixed(1), fromFirstPublishMs: +r.fromFirstPublishMs.toFixed(1), versions: r.versions, positionMs: +r.positionMs.toFixed(2), reflowToPanelMs: +r.reflowToPanelMs.toFixed(1), cards: r.cards, misplaced: r.misplaced, sameFrame: r.sameFrame })
  }
  // Baseline for the report: the same trims with the panel hidden (publish -> painted is then the
  // reflow's own paint); the difference is what the panel adds.
  await (await reveal(page, 'comment.panel')).click()
  await expect(page.locator('[data-testid="comments-panel"]')).toHaveCount(0)
  const baseline: { trim: string; readyMs: number }[] = []
  for (const trim of ['us-6x9', 'uk-a5', 'us-5.5x8.5']) {
    const ms = await page.evaluate(async (id) => {
      const v0 = window.__nvE2E.layout().layoutVersion
      window.__nvE2E.setTrimSize(id)
      await new Promise<void>((resolve) => {
        const check = () => (window.__nvE2E.paginationModelSettled() && window.__nvE2E.layout().layoutVersion > v0 ? resolve() : requestAnimationFrame(check))
        check()
      })
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => {
          const ch = new MessageChannel()
          ch.port1.onmessage = () => resolve()
          ch.port2.postMessage(null)
        }),
      )
      return performance.now() - (window.__nvE2E.layoutPublishedAt(window.__nvE2E.layout().layoutVersion) ?? 0)
    }, trim)
    baseline.push({ trim, readyMs: +ms.toFixed(1) })
  }
  const added = runs.map((r, i) => +(r.panelReadyMs - baseline[i].readyMs).toFixed(1))
  await report(testInfo, 'comments-panel-layout', {
    threads,
    runs,
    baselineWithoutPanel: baseline,
    panelAddedMs: added,
    maxPanelReadyMs: Math.max(...runs.map((r) => r.panelReadyMs)),
    maxPanelCommitMs: Math.max(...runs.map((r) => r.panelCommitMs)),
    budgets: { panelCommitMs: 100 },
  })
  for (const r of runs) {
    expect(r.cards, `${r.trim}: cards on the spread in view`).toBeGreaterThan(0)
    expect(r.misplaced, `${r.trim}: cards positioned for the new layout`).toBe(0)
    // The cards move in the same frame as the pages: positioned before the first paint of the new layout.
    expect(r.sameFrame, `${r.trim}: cards positioned before the reflowed pages are painted`).toBe(true)
    // Gated: from the new page model being published to the visible spread's cards rendered and positioned.
    // Publish to painted (panelReadyMs) and the panel-hidden delta are reported only: they include the
    // reflowed pages' own paint, which the reflow budget covers (decision b4f37763).
    budget(testInfo, `${r.trim}: panel re-layout ms (publish to cards rendered and positioned)`, r.panelCommitMs, 100)
  }
})
