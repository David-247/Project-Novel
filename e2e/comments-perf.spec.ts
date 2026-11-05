import { mkdirSync, writeFileSync } from 'node:fs'
import { expect, test, type Page, type TestInfo } from '@playwright/test'
import { budget } from './budget'
import { buildPaginationFixture } from './fixtures/pagination-manuscript'
import { clickBlockStart, editor, launch, lineEnd, openRecent, saveStatus, seedProject, waitForLayout, writeFile } from './helpers'

/**
 * Comments performance (serial perf projects, like pagination-perf.spec.ts): the 100,000-word
 * manuscript with 500 comment threads.
 *  - typing latency (keydown -> next frame painted), median < 50 ms;
 *  - margin panel re-layout after a reflow (a trim size change), < 100 ms for the visible spread.
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
  const runs: { trim: string; panelLayoutMs: number; reflowToPanelMs: number; cards: number }[] = []
  for (const trim of ['us-6x9', 'uk-a5', 'us-5.5x8.5']) {
    const r = await page.evaluate(async (id) => {
      const v = window.__nvE2E.layout().layoutVersion
      const t0 = performance.now()
      window.__nvE2E.setTrimSize(id)
      await new Promise<void>((resolve) => {
        const check = () => {
          const l = window.__nvE2E.layout()
          const c = window.__nvE2E.comments().layout
          if (window.__nvE2E.paginationModelSettled() && l.layoutVersion > v && c.laidOutVersion >= l.layoutVersion) resolve()
          else requestAnimationFrame(check)
        }
        requestAnimationFrame(check)
      })
      const c = window.__nvE2E.comments().layout
      return { panelLayoutMs: c.lastLayoutMs, reflowToPanelMs: performance.now() - t0, cards: document.querySelectorAll('[data-testid="comments-panel"] article[data-thread-id]').length }
    }, trim)
    runs.push({ trim, panelLayoutMs: +r.panelLayoutMs.toFixed(2), reflowToPanelMs: +r.reflowToPanelMs.toFixed(1), cards: r.cards })
  }
  await report(testInfo, 'comments-panel-layout', { threads, runs, maxPanelLayoutMs: Math.max(...runs.map((r) => r.panelLayoutMs)), budgets: { panelLayoutMs: 100 } })
  for (const r of runs) {
    expect(r.cards, `${r.trim}: cards on the spread in view`).toBeGreaterThan(0)
    budget(testInfo, `${r.trim}: panel re-layout ms`, r.panelLayoutMs, 100)
  }
})
