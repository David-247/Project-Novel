import { mkdirSync, writeFileSync } from 'node:fs'
import { expect, test, type Page, type TestInfo } from '@playwright/test'
import { budget } from './budget'
import { buildPaginationFixture } from './fixtures/pagination-manuscript'
import { clickBlockStart, editor, launch, lineEnd, newProject, openRecent, readFile, saveStatus, isBookMode, showPage, turnSettled, waitForLayout, reveal } from './helpers'

/**
 * Phase 2 acceptance (Book Layout), end to end through the UI, in chromium and webkit:
 * paste the ~100k-word fixture manuscript into a new project; switch through several trim sizes
 * (reflow complete < 1 s each, budget() per decision afbe3475); edit the Chapter Title style and
 * see every chapter update; add a footnote and find it on its reference's page; turn page numbers on
 * and read them on specific pages; switch the Book, White, Dark and Auto paper; save, reopen, and
 * get identical settings and an identical layout.
 *
 * Runs in the serial projects (perf-chromium, perf-webkit; playwright.config.ts) so the reflow
 * budgets are measured on a quiet CPU. Reflow numbers go to perf-results/acceptance-*.json (job summary).
 */

// A worker-scoped option of its own gives this file a fresh worker and browser: in the serial perf
// projects it otherwise inherits a browser process that already ran seven 100k-word tests (their
// memory and caches are not the app's). Nothing else changes.
test.use({ launchOptions: { env: { ...process.env, NV_E2E_FRESH_BROWSER: 'phase2-acceptance' } } })

const ctl = (page: Page, id: string) => page.locator(`[data-control-id="${id}"]`)
const layout = (page: Page) => page.evaluate(() => window.__nvE2E.layout())
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

type Run = { type: 'text'; text: string; marks?: { type: string }[] }
type Block = { type: string; attrs?: { level?: number }; content: Run[] }

/** The fixture as the HTML a word processor puts on the clipboard (h1 chapters, p with em / strong). */
function fixtureHtml(blocks: Block[]): string {
  return blocks
    .map((b) => {
      const inner = b.content
        .map((r) => {
          const t = esc(r.text)
          const m = r.marks?.[0]?.type
          return m === 'italic' ? `<em>${t}</em>` : m === 'bold' ? `<strong>${t}</strong>` : t
        })
        .join('')
      return b.type === 'heading' ? `<h1>${inner}</h1>` : `<p>${inner}</p>`
    })
    .join('')
}

async function pasteHtml(page: Page, html: string, text: string) {
  await editor(page).click()
  await editor(page).evaluate(
    (el, [h, t]) => {
      const data = new DataTransfer()
      data.setData('text/html', h)
      data.setData('text/plain', t)
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
    },
    [html, text] as const,
  )
  await waitForLayout(page)
}

/**
 * Time from the click on `selector` (a DOM click in the page, so the measurement does not include
 * Playwright's round trip) to "reflow complete" (docs/pagination.md): the new page model published
 * and the pages in view drawn and painted. Then waits until every block is drawn.
 */
async function timeReflow(page: Page, selector: string): Promise<{ ms: number; syncMs: number; passMs: number; allDrawnMs: number }> {
  return page.evaluate(async (sel) => {
    const el = document.querySelector<HTMLElement>(sel)
    if (!el) throw new Error(`no ${sel}`)
    const v = window.__nvE2E.layout().layoutVersion
    const t0 = performance.now()
    el.click()
    const syncMs = performance.now() - t0
    // The pagination engine's own synchronous pass (the rest of syncMs is UI work around it).
    const passMs = (window.__nvE2E.paginationLines().lastPass as { totalMs?: number } | null)?.totalMs ?? -1
    await new Promise<void>((resolve) => {
      const check = () =>
        window.__nvE2E.paginationModelSettled() && window.__nvE2E.layout().layoutVersion > v ? resolve() : requestAnimationFrame(check)
      requestAnimationFrame(check)
    })
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)))
    const ms = performance.now() - t0
    await new Promise<void>((resolve) => {
      const check = () => (window.__nvE2E.paginationSettled() ? resolve() : requestAnimationFrame(check))
      check()
    })
    return { ms: +ms.toFixed(1), syncMs: +syncMs.toFixed(1), passMs: +passMs.toFixed(1), allDrawnMs: +(performance.now() - t0).toFixed(1) }
  }, selector)
}

async function chooseTrim(page: Page, id: string, label: RegExp) {
  await (await reveal(page, 'book.trimSize')).click()
  await expect(page.getByRole('menuitemradio', { name: label })).toBeVisible()
  const before = (await layout(page)).pageCount
  const r = await timeReflow(page, `[data-control-id="book.trimSize.${id}"]`)
  await expect(page.getByRole('menu')).toHaveCount(0)
  await waitForLayout(page)
  const l = await layout(page)
  console.info(`[acceptance] trim ${id}: reflow ${r.ms} ms (sync ${r.syncMs}, engine pass ${r.passMs}), all drawn ${r.allDrawnMs} ms, ${before} -> ${l.pageCount} pages`)
  return { trim: id, ...r, pages: l.pageCount }
}

/** Reflow numbers to perf-results/acceptance-<project>-<platform>.json (CI job summary). */
function record(testInfo: TestInfo, reflows: { trim: string; ms: number; allDrawnMs: number; pages: number }[], styleEdit: { ms: number; allDrawnMs: number }) {
  const out = {
    scenario: 'acceptance',
    browser: testInfo.project.name,
    platform: process.platform,
    reflows,
    maxReflowMs: Math.max(...reflows.map((r) => r.ms)),
    maxAllDrawnMs: Math.max(...reflows.map((r) => r.allDrawnMs)),
    chapterStyleEdit: styleEdit,
    budgets: { reflowMs: 1000, allDrawnMs: 3000 },
    measuredAt: new Date().toISOString(),
  }
  mkdirSync('perf-results', { recursive: true })
  writeFileSync(`perf-results/acceptance-${testInfo.project.name}-${process.platform}.json`, JSON.stringify(out, null, 2))
}

/** Page index of the frame whose box holds the painted footnote reference `k`. */
async function pageOfRef(page: Page, k: number): Promise<number> {
  return page.evaluate((i) => {
    const ref = document.querySelectorAll('.ProseMirror [data-footnote-ref]')[i]!.getBoundingClientRect()
    const cx = ref.left + ref.width / 2
    const cy = ref.top + ref.height / 2
    for (const f of Array.from(document.querySelectorAll<HTMLElement>('.nv-frames .nv-page'))) {
      const r = f.getBoundingClientRect()
      if (cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom) return Number(f.dataset.pageIndex)
    }
    return -1
  }, k)
}

/** Footer page number shown on each rendered page frame (virtualised: the pages near the view). */
async function footerNumbers(page: Page): Promise<Map<number, string>> {
  await waitForLayout(page)
  const read = () =>
    page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLElement>('.nv-frames .nv-page')).map((f) => [
        Number(f.dataset.pageIndex),
        f.querySelector('[data-hf-region="footer"] [data-hf="number"]')?.textContent ?? '',
      ]),
    )
  const rows = await read()
  // Book mode renders the spread shown only: also read the next one, then turn back.
  if (await isBookMode(page)) {
    if (await page.evaluate(() => window.__nvE2E.turnSpread(1))) {
      await turnSettled(page)
      rows.push(...(await read()))
      await page.evaluate(() => window.__nvE2E.turnSpread(-1))
      await turnSettled(page)
    }
  }
  return new Map(rows as [number, string][])
}

/** What must survive save and reopen. */
async function snapshot(page: Page) {
  await waitForLayout(page)
  const l = await layout(page)
  return {
    pageCount: l.pageCount,
    pages: l.pages,
    effectiveView: l.effectiveView,
    surface: await page.locator('html').getAttribute('data-surface'),
    trimLabel: (await (await reveal(page, 'book.trimSize')).textContent())?.trim(),
    chapterTitleSize: await editor(page).locator('h1[data-style="chapter-title"]').first().evaluate((el) => getComputedStyle(el).fontSize),
    footnotes: await page.evaluate(() => window.__nvE2E.footnotes().map((f) => ({ label: f.label, text: f.text }))),
    styles: await page.evaluate(() => window.__nvE2E.bookStyles()),
  }
}

test('Phase 2 acceptance: paste, trims, chapter style, footnote, page numbers, surfaces, save and reopen', async ({ page }, testInfo) => {
  test.setTimeout(420_000)
  await page.emulateMedia({ colorScheme: 'light' })
  await page.setViewportSize({ width: 1400, height: 900 })
  const fx = buildPaginationFixture()
  const blocks = fx.doc.content as Block[]
  const folder = '/projects/Acceptance'

  // ---- 1. Paste the long fixture manuscript into a new project.
  await launch(page)
  await newProject(page, folder)
  const plain = blocks.map((b) => b.content.map((r) => r.text).join('')).join('\n\n')
  await pasteHtml(page, fixtureHtml(blocks), plain)
  const titles = editor(page).locator('h1[data-style="chapter-title"]')
  await expect(titles).toHaveCount(fx.chapters)
  await expect(editor(page).locator(':scope > p')).toHaveCount(blocks.length - fx.chapters)
  const l0 = await layout(page)
  expect(l0.effectiveView).toBe('spread')
  expect(l0.pageCount).toBeGreaterThan(200)
  // Chapters (Chapter Title breaks to a new page) open their own page, in order.
  const openings0 = l0.pages.filter((p) => p.startsBlockType === 'heading').map((p) => p.index)
  expect(openings0).toHaveLength(fx.chapters)
  await expect(page.getByTestId('page-indicator')).toHaveText(new RegExp(` of ${l0.pageCount}$`))

  // ---- 2. Several trim sizes through the picker; each reflow < 1 s.
  const trims: [string, RegExp][] = [
    ['us-6x9', /Large trade/],
    ['us-5x8', /Digest/],
    ['uk-a5', /A5/],
    ['us-mass-market', /Mass market/],
    ['us-5.5x8.5', /^Trade/],
  ]
  const counts: Record<string, number> = {}
  const reflows: Awaited<ReturnType<typeof chooseTrim>>[] = []
  for (const [id, label] of trims) {
    const r = await chooseTrim(page, id, label)
    reflows.push(r)
    counts[id] = r.pages
  }
  // Smaller pages hold less: the page count follows the trim, and coming back gives the same book.
  expect(counts['us-mass-market']).toBeGreaterThan(counts['us-6x9'])
  expect(counts['us-5.5x8.5']).toBe(l0.pageCount)
  await expect((await reveal(page, 'book.trimSize'))).toContainText('Trade')

  // ---- 3. Edit the Chapter Title style: every chapter updates (no document change).
  const sizes = () => titles.evaluateAll((els) => els.map((el) => parseFloat(getComputedStyle(el).fontSize)))
  const sizeBefore = await sizes()
  await clickBlockStart(page, titles.nth(3))
  await (await reveal(page, 'styles.edit')).click()
  const modify = page.getByRole('dialog', { name: 'Modify style: Chapter Title' })
  await expect(modify).toBeVisible()
  await modify.locator('[data-control-id="styles.field.fontSize"]').fill('28')
  const docVersion = await page.evaluate(() => window.__nvE2E.docVersion())
  const restyle = await timeReflow(page, '[data-control-id="styles.modify.save"]')
  await expect(modify).toBeHidden()
  const sizeAfter = await sizes()
  expect(sizeAfter).toHaveLength(fx.chapters)
  for (const [i, s] of sizeAfter.entries()) expect(s, `chapter ${i + 1}`).toBeCloseTo((sizeBefore[i] * 28) / 20, 0)
  expect(await page.evaluate(() => window.__nvE2E.docVersion())).toBe(docVersion)
  // Budgets (decision afbe3475: blocking on the shipping pairs, warnings elsewhere), after recording.
  record(testInfo, reflows, restyle)
  for (const r of reflows) {
    budget(testInfo, `trim ${r.trim}: reflow complete ms`, r.ms, 1000)
    budget(testInfo, `trim ${r.trim}: all blocks drawn ms`, r.allDrawnMs, 3000)
  }
  budget(testInfo, 'chapter style edit: reflow complete ms', restyle.ms, 1000)
  const l1 = await layout(page)
  expect(l1.pages.filter((p) => p.startsBlockType === 'heading')).toHaveLength(fx.chapters)

  // ---- 4. Add a footnote mid-book: the note is at the bottom of the reference's page.
  const target = editor(page).locator(':scope > p').nth(Math.floor((blocks.length - fx.chapters) / 2))
  await clickBlockStart(page, target)
  await lineEnd(page)
  await (await reveal(page, 'insert.menu')).click()
  await ctl(page, 'footnote.insert').click()
  const box = page.getByTestId('footnote-editor')
  await expect(box).toBeFocused()
  await page.keyboard.type('Acceptance note.')
  await page.keyboard.press('Escape')
  await expect(box).toHaveCount(0)
  await expect(editor(page)).toBeFocused()
  await waitForLayout(page)
  expect(await page.evaluate(() => window.__nvE2E.footnotes())).toEqual([{ pos: expect.any(Number), label: '1', text: 'Acceptance note.' }])
  const refPage = await pageOfRef(page, 0)
  expect(refPage).toBeGreaterThan(0)
  await expect(page.locator(`.nv-frames .nv-page[data-page-index="${refPage}"] .nv-fn-area`)).toHaveText('1 Acceptance note.')
  for (const other of [refPage - 1, refPage + 1]) {
    // The neighbour is rendered (so this looks at a real page); it may rightly have no footnote area.
    // (Book mode: a neighbour on the other spread is turned to first.)
    await showPage(page, other)
    await expect(page.locator(`.nv-frames .nv-page[data-page-index="${other}"]`)).toHaveCount(1)
    const areas = await page.locator(`.nv-frames .nv-page[data-page-index="${other}"] .nv-fn-area`).allTextContents()
    expect(areas.join(' '), `footnote area of page ${other}`).not.toContain('Acceptance note.')
  }

  // ---- 5. Page numbers: off, then on (outside corner of the footer); read them on specific pages.
  await (await reveal(page, 'book.headerFooter')).click()
  const hf = page.getByRole('dialog', { name: 'Headers & page numbers' })
  await expect(hf).toBeVisible()
  await ctl(page, 'book.headerFooter.numberPosition').selectOption('none')
  await ctl(page, 'book.headerFooter.done').click()
  await expect(hf).toHaveCount(0)
  expect([...(await footerNumbers(page)).values()].every((n) => n === '')).toBe(true)
  await (await reveal(page, 'book.headerFooter')).click()
  await ctl(page, 'book.headerFooter.numberPosition').selectOption('footer-outside')
  await ctl(page, 'book.headerFooter.done').click()
  await expect(hf).toHaveCount(0)
  const l2 = await layout(page)
  expect(l2.pageCount).toBe(l1.pageCount) // numbers never reflow the body
  const openings = l2.pages.filter((p) => p.startsBlockType === 'heading').map((p) => p.index)
  // No front matter: chapter 1 opens on page index 0, which counts as 1. Numbers are off on opening pages.
  expect(openings[0]).toBe(0)
  for (const ch of [1, 12, fx.chapters - 1]) {
    await clickBlockStart(page, titles.nth(ch))
    const shown = await footerNumbers(page)
    const open = openings[ch]
    // The frames near the view are rendered (one viewport either side): the pages sampled must be among them.
    expect(shown.has(open), `chapter ${ch + 1} opening page ${open} is rendered`).toBe(true)
    expect(shown.get(open), `chapter ${ch + 1} opening page ${open}`).toBe('')
    let checked = 0
    for (const p of [open + 1, open + 2]) {
      if (l2.pages[p].isBlank || openings.includes(p)) continue
      expect(shown.has(p), `page index ${p} is rendered`).toBe(true)
      expect(shown.get(p), `page index ${p}`).toBe(String(p + 1))
      checked++
    }
    expect(checked, `numbered pages checked after chapter ${ch + 1} opens`).toBeGreaterThan(0)
    // The number sits in the outside corner: right on a recto, left on a verso.
    await showPage(page, open + 1)
    const pos = await page.evaluate((i) => {
      const f = document.querySelector(`.nv-frames .nv-page[data-page-index="${i}"]`)!
      const n = f.querySelector('[data-hf-region="footer"] [data-hf="number"]')!
      const fr = f.getBoundingClientRect()
      const nr = n.getBoundingClientRect()
      return { side: (f as HTMLElement).dataset.side, centre: (nr.left + nr.right) / 2 - fr.left, width: fr.width }
    }, open + 1)
    expect(pos.side === 'recto' ? pos.centre > pos.width / 2 : pos.centre < pos.width / 2, JSON.stringify(pos)).toBe(true)
  }
  // Navigation: PageDown moves to the next spread, and the indicator follows. (Back to the caret's
  // spread first: the checks above turned the view without moving the caret.)
  await showPage(page, (await layout(page)).currentPage)
  const indicator = page.getByTestId('page-indicator')
  const before = await indicator.textContent()
  await page.keyboard.press('PageDown')
  await expect(indicator).not.toHaveText(before!)

  // ---- 6. Paper surfaces: Book, White, Dark, Auto (colours only: no reflow).
  const pageBg = () => page.locator('.nv-frames .nv-page').first().evaluate((el) => getComputedStyle(el).backgroundColor)
  for (const [value, surface, bg] of [
    ['book', 'book', 'rgb(244, 234, 210)'],
    ['white', 'white', 'rgb(255, 255, 255)'],
    ['dark', 'dark', 'rgb(32, 35, 39)'],
    ['auto', 'white', 'rgb(255, 255, 255)'],
  ] as const) {
    await (await reveal(page, `book.surface.${value}`)).click()
    await expect((await reveal(page, `book.surface.${value}`))).toHaveAttribute('aria-checked', 'true')
    await expect(page.locator('html')).toHaveAttribute('data-surface', surface)
    await expect.poll(pageBg).toBe(bg)
  }
  await (await reveal(page, 'book.surface.book')).click()
  expect((await layout(page)).pages).toEqual(l2.pages)

  // ---- 7. Save, reopen: identical settings and layout.
  await page.keyboard.press('ControlOrMeta+s')
  await expect(saveStatus(page)).toHaveText('Acceptance: Saved')
  const saved = await snapshot(page)
  const bookJson = JSON.parse((await readFile(page, `${folder}/book.json`))!)
  expect(bookJson).toMatchObject({
    trimSize: 'us-5.5x8.5',
    surface: 'book',
    view: 'spread',
    styles: { 'chapter-title': { fontSize: 28 } },
    headerFooter: { pageNumber: { position: 'footer-outside' } },
  })

  await page.reload()
  await launch(page)
  await openRecent(page, folder)
  await expect(saveStatus(page)).toHaveText('Acceptance: All changes saved', { timeout: 60_000 })
  await expect(titles).toHaveCount(fx.chapters)
  const reopened = await snapshot(page)
  expect(reopened).toEqual(saved)
  expect(JSON.parse((await readFile(page, `${folder}/book.json`))!)).toEqual(bookJson)
  await clickBlockStart(page, titles.nth(12))
  const shown = await footerNumbers(page)
  const p = openings[12] + 1
  expect(reopened.pages[p].isBlank, `page index ${p} is a body page`).toBe(false)
  expect(shown.has(p), `page index ${p} is rendered`).toBe(true)
  expect(shown.get(p)).toBe(String(p + 1))
})
