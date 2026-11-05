import { expect, test, type Page } from '@playwright/test'
import { chooseScrollNavigation, docEnd, docStart, editor, launch, openRecent, projectNavigation, saveStatus, seedProject, seedProjectNavigation, waitForLayout, writeFile } from './helpers'

// Book mode flows. In the *-scroll projects (continuous scroll) only the tests that hold in both modes run.
const BOTH_MODES = new Set([
  'keys in the manuscript: PageDown / PageUp and Ctrl+Home / Ctrl+End turn with the caret; Go to Page',
  "comments margin panel shows the shown spread's comments; Next Comment turns to the next one",
])
test.beforeEach(async ({ page }, testInfo) => {
  test.skip(projectNavigation(testInfo) === 'scroll' && !BOTH_MODES.has(testInfo.title), 'Book mode only')
  await seedProjectNavigation(page, testInfo)
})

/**
 * Book mode, the default page navigation (docs/pagination.md "Navigation modes"): one spread on the
 * desk, turned like a book; continuous scroll (Phase 2) as the alternative.
 */

const layout = (page: Page) => page.evaluate(() => window.__nvE2E.layout())
const spread = async (page: Page) => (await layout(page)).visibleSpread
const indicator = (page: Page) => page.getByTestId('page-indicator')
const desk = (page: Page) => page.getByTestId('paginated-view')
const ctl = (page: Page, id: string) => page.locator(`[data-control-id="${id}"]`)
const prevCtl = (page: Page) => ctl(page, 'pagination.previousSpread')
const nextCtl = (page: Page) => ctl(page, 'pagination.nextSpread')
const head = (page: Page) => page.evaluate(() => window.__nvE2E.editorDiag()!.selection as { head: number; anchor: number })

const WORDS = 'night river quiet lantern stone window garden letter morning shadow silver harbor whisper meadow'.split(' ')
function paragraphs(count: number, words = 100) {
  let n = 0
  return Array.from({ length: count }, (_, i) => {
    const len = Math.max(8, Math.round(words * (0.4 + ((i * 37) % 13) / 10)))
    return Array.from({ length: len }, () => WORDS[(n++ * 5) % WORDS.length]).join(' ')
  })
}

async function paste(page: Page, blocks: string[]) {
  await editor(page).click()
  await editor(page).evaluate((el, text) => {
    const data = new DataTransfer()
    data.setData('text/plain', text)
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  }, blocks.join('\n\n'))
  await waitForLayout(page)
}

async function book(page: Page, count = 40) {
  await page.setViewportSize({ width: 1400, height: 900 })
  await launch(page)
  await paste(page, paragraphs(count))
  await page.waitForTimeout(600) // the paste's undo group closes
  return (await layout(page)).pageCount
}

/** Client points on the blank desk left and right of the spread, at mid height. */
async function blankPoints(page: Page) {
  const s = (await page.locator('.nv-sizer').boundingBox())!
  const d = (await desk(page).boundingBox())!
  const y = s.y + s.height / 2
  // Between the lane (turn control) and the spread, or in the lane above / below the control.
  return { left: { x: (d.x + s.x) / 2, y: s.y + 20 }, right: { x: (s.x + s.width + d.x + d.width) / 2, y: s.y + 20 }, y }
}

/** Every rendered page frame lies inside the one-spread window and no block painted there is hidden. */
async function shownSpreadDrawn(page: Page) {
  return page.evaluate(() => {
    const sizer = document.querySelector('.nv-sizer')!.getBoundingClientRect()
    const frames = Array.from(document.querySelectorAll('.nv-frames .nv-page')).map((f) => f.getBoundingClientRect())
    const inside = frames.every((f) => f.top >= sizer.top - 1 && f.bottom <= sizer.bottom + 1)
    const stale = Array.from(document.querySelectorAll('.novel-editor-content .nv-stale')).filter((el) => {
      const r = el.getBoundingClientRect()
      return r.bottom > sizer.top && r.top < sizer.bottom
    }).length
    return { frames: frames.length, inside, stale }
  })
}

test('a fresh install opens in Book mode: one spread, centred, no scrolling between spreads', async ({ page }) => {
  const pageCount = await book(page)
  expect(pageCount).toBeGreaterThan(8)
  expect(await page.evaluate(() => window.__nvE2E.pageNavigation())).toBe('book')
  await expect(desk(page)).toHaveAttribute('data-navigation', 'book')
  // Only the spread shown is on the desk (page 1 alone, as the first page of a printed book).
  expect(await shownSpreadDrawn(page)).toEqual({ frames: 1, inside: true, stale: 0 })
  await expect(indicator(page)).toHaveText(`Page 1 of ${pageCount}`)
  // Nothing to scroll: the spread fits the window (fit spread).
  const main = page.getByRole('main', { name: 'Editor' })
  expect(await main.evaluate((m) => m.scrollHeight - m.clientHeight)).toBeLessThanOrEqual(2)
  await page.mouse.move(700, 450)
  await page.mouse.wheel(0, 0) // no-op
  // Both turn controls are visible (not hover-only); the previous one is disabled on the first spread.
  await expect(prevCtl(page)).toBeVisible()
  await expect(nextCtl(page)).toBeVisible()
  await expect(prevCtl(page)).toHaveAttribute('aria-disabled', 'true')
  await expect(nextCtl(page)).not.toHaveAttribute('aria-disabled')
})

test('presses on the blank desk turn the page; the caret stays; the turn controls and their edges', async ({ page }) => {
  const pageCount = await book(page)
  await docStart(page)
  const caret = await head(page)
  const pts = await blankPoints(page)
  await page.mouse.click(pts.right.x, pts.right.y)
  await expect(indicator(page)).toHaveText(`Pages 2–3 of ${pageCount}`)
  expect(await shownSpreadDrawn(page)).toEqual({ frames: 2, inside: true, stale: 0 })
  await page.mouse.click(pts.right.x, pts.right.y)
  await expect(indicator(page)).toHaveText(`Pages 4–5 of ${pageCount}`)
  await page.mouse.click(pts.left.x, pts.left.y)
  await expect(indicator(page)).toHaveText(`Pages 2–3 of ${pageCount}`)
  // The caret did not move, and the manuscript kept the focus.
  expect(await head(page)).toEqual(caret)
  await expect(editor(page)).toBeFocused()

  // A press on the pages still places the caret.
  const p = page.locator('.nv-frames .nv-page[data-page-index="2"]')
  const box = (await p.boundingBox())!
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  await expect.poll(async () => (await layout(page)).currentPage).toBe(2)

  // Turn controls: click, and keyboard (Tab reaches them; Enter / Space turn; Home / End to the edges).
  await nextCtl(page).click()
  await expect(indicator(page)).toHaveText(`Pages 4–5 of ${pageCount}`)
  await prevCtl(page).focus()
  await page.keyboard.press('Enter')
  await expect(indicator(page)).toHaveText(`Pages 2–3 of ${pageCount}`)
  await page.keyboard.press('End')
  const last = (await layout(page)).pages.length - 1
  await expect.poll(async () => (await spread(page)).last).toBe(last)
  await expect(nextCtl(page)).toHaveAttribute('aria-disabled', 'true')
  // At the last spread every way on stops there.
  const before = await spread(page)
  await nextCtl(page).click({ force: true }) // aria-disabled: Playwright would wait for it to enable
  await page.mouse.click(pts.right.x, pts.right.y)
  await nextCtl(page).focus()
  await page.keyboard.press('PageDown') // focus on a turn control: view only
  await page.waitForTimeout(100)
  expect(await spread(page)).toEqual(before)
  await page.keyboard.press('Home')
  await expect(indicator(page)).toHaveText(`Page 1 of ${pageCount}`)
  await expect(prevCtl(page)).toHaveAttribute('aria-disabled', 'true')
  await page.keyboard.press('PageUp')
  await expect(indicator(page)).toHaveText(`Page 1 of ${pageCount}`)
  await page.keyboard.press('PageDown')
  await expect(indicator(page)).toHaveText(`Pages 2–3 of ${pageCount}`)
})

test('a tap on the blank desk turns the page (touch)', async ({ browser }) => {
  const context = await browser.newContext({ hasTouch: true, viewport: { width: 1400, height: 900 } })
  const page = await context.newPage()
  await launch(page)
  await paste(page, paragraphs(30))
  const pageCount = (await layout(page)).pageCount
  const pts = await blankPoints(page)
  await page.touchscreen.tap(pts.right.x, pts.right.y)
  await expect(indicator(page)).toHaveText(`Pages 2–3 of ${pageCount}`)
  await page.touchscreen.tap(pts.left.x, pts.left.y)
  await expect(indicator(page)).toHaveText(`Page 1 of ${pageCount}`)
  await context.close()
})

test('one wheel or trackpad gesture turns one spread, vertical or horizontal', async ({ page }) => {
  const pageCount = await book(page)
  await page.mouse.move(700, 450)
  // A swipe with momentum: many events close together (16 ms apart, decaying) turn once.
  await desk(page).evaluate(async (el) => {
    const r = el.getBoundingClientRect()
    for (let i = 0; i < 24; i++) {
      el.dispatchEvent(new WheelEvent('wheel', { deltaY: 60 - i * 2.4, clientX: r.left + r.width / 2, clientY: r.top + 200, bubbles: true, cancelable: true }))
      await new Promise((res) => setTimeout(res, 16))
    }
  })
  await expect(indicator(page)).toHaveText(`Pages 2–3 of ${pageCount}`)
  await page.waitForTimeout(400)
  expect((await spread(page)).index).toBe(1)
  // The next gesture turns again; back with the reverse direction; horizontal too.
  await page.mouse.wheel(0, 100)
  await expect(indicator(page)).toHaveText(`Pages 4–5 of ${pageCount}`)
  await page.waitForTimeout(400)
  await page.mouse.wheel(0, -100)
  await expect(indicator(page)).toHaveText(`Pages 2–3 of ${pageCount}`)
  await page.waitForTimeout(400)
  await page.mouse.wheel(120, 0)
  await expect(indicator(page)).toHaveText(`Pages 4–5 of ${pageCount}`)
  await page.waitForTimeout(400)
  await page.mouse.wheel(-120, 0)
  await expect(indicator(page)).toHaveText(`Pages 2–3 of ${pageCount}`)
  await page.waitForTimeout(400)
  await page.mouse.wheel(0, -100)
  await expect(indicator(page)).toHaveText(`Page 1 of ${pageCount}`)
  // At the first spread a wheel up does nothing.
  await page.waitForTimeout(400)
  await page.mouse.wheel(0, -100)
  await page.waitForTimeout(100)
  expect((await spread(page)).index).toBe(0)
})

test('keys in the manuscript: PageDown / PageUp and Ctrl+Home / Ctrl+End turn with the caret; Go to Page', async ({ page }) => {
  const pageCount = await book(page)
  await docStart(page)
  await page.keyboard.press('PageDown')
  await expect.poll(async () => (await layout(page)).currentPage).toBe(1)
  await expect(indicator(page)).toHaveText(`Pages 2–3 of ${pageCount}`)
  await page.keyboard.press('PageDown')
  await expect(indicator(page)).toHaveText(`Pages 4–5 of ${pageCount}`)
  await page.keyboard.press('PageUp')
  await expect(indicator(page)).toHaveText(`Pages 2–3 of ${pageCount}`)
  await docEnd(page)
  const last = (await layout(page)).pages.length - 1
  await expect.poll(async () => (await spread(page)).last).toBe(last)
  await expect.poll(async () => (await layout(page)).currentPage).toBe(last)
  await docStart(page)
  await expect(indicator(page)).toHaveText(`Page 1 of ${pageCount}`)
  // The page shown is drawn where the caret is (it is painted inside the window).
  expect(await shownSpreadDrawn(page)).toMatchObject({ inside: true, stale: 0 })

  // Edit > Go to Page: the spread holding that page.
  await page.locator('[data-control-id="menu.edit"]').click()
  await page.locator('[role="menu"] [data-control-id="edit.go_to_page"]').click()
  await page.locator('[data-control-id="goToPage.number"]').fill('7')
  await page.keyboard.press('Enter')
  await expect(indicator(page)).toHaveText(`Pages 6–7 of ${pageCount}`)
  await expect.poll(async () => (await layout(page)).currentPage).toBe(6)
})

test('View menu: Book / Continuous Scroll radio, and the spread commands with their disabled edges', async ({ page }) => {
  const pageCount = await book(page)
  const open = () => page.locator('[data-control-id="menu.view"]').click()
  const item = (id: string) => page.locator(`[role="menu"] [data-control-id="${id}"]`)
  await open()
  await expect(item('view.bookNavigation')).toHaveAttribute('aria-checked', 'true')
  await expect(item('pagination.previousSpread')).toHaveAttribute('aria-disabled', 'true')
  await item('pagination.nextSpread').click()
  await expect(indicator(page)).toHaveText(`Pages 2–3 of ${pageCount}`)
  await open()
  await item('view.lastSpread').click()
  await expect.poll(async () => (await spread(page)).last).toBe(pageCount - 1)
  await open()
  await expect(item('view.lastSpread')).toHaveAttribute('aria-disabled', 'true')
  await item('view.firstSpread').click()
  await expect(indicator(page)).toHaveText(`Page 1 of ${pageCount}`)

  // Continuous scroll from the View menu: every page in one column again.
  await open()
  await item('view.scrollNavigation').click()
  await expect(desk(page)).toHaveAttribute('data-navigation', 'scroll')
  await expect(prevCtl(page)).toHaveCount(0)
  const main = page.getByRole('main', { name: 'Editor' })
  expect(await main.evaluate((m) => m.scrollHeight - m.clientHeight)).toBeGreaterThan(2000)
})

test('caret follow: typing past the last line of the recto, arrowing off the spread, a find jump', async ({ page }) => {
  const pageCount = await book(page)
  // Caret at the end of page 3's last line (a recto), then type until the text flows onto page 4.
  const l = await layout(page)
  const recto = l.pages[2]
  await page.evaluate((pos) => window.__nvE2E.selectText(pos, pos), recto.to - 1)
  await expect(indicator(page)).toHaveText(`Pages 2–3 of ${pageCount}`)
  const typed = ' lantern'.repeat(14)
  await page.keyboard.type(typed)
  await waitForLayout(page)
  await expect.poll(async () => (await layout(page)).currentPage).toBeGreaterThanOrEqual(3)
  await expect(indicator(page)).toHaveText(`Pages 4–5 of ${pageCount}`)
  expect(await shownSpreadDrawn(page)).toMatchObject({ inside: true, stale: 0 })

  // ArrowUp off the top of the verso goes back to the previous spread.
  await page.keyboard.press('PageUp') // caret to the top of page 2 (verso), spread 2–3
  await expect(indicator(page)).toHaveText(`Pages 2–3 of ${pageCount}`)
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('ArrowUp')
  await expect.poll(async () => (await layout(page)).currentPage).toBe(0)
  await expect(indicator(page)).toHaveText(`Page 1 of ${pageCount}`)
  // ArrowDown off the bottom of the recto: to the next spread.
  await page.keyboard.press('PageDown')
  const last2 = (await layout(page)).pages[2]
  await page.evaluate((pos) => window.__nvE2E.selectText(pos, pos), last2.to - 2)
  await page.keyboard.press('ArrowDown')
  await expect.poll(async () => (await layout(page)).currentPage).toBe(3)
  await expect(indicator(page)).toHaveText(`Pages 4–5 of ${pageCount}`)

  // Find: the match on a later spread turns there, and its highlight is painted on the spread shown.
  const later = (await layout(page)).pages[9]
  await page.evaluate((pos) => window.__nvE2E.selectText(pos, pos), later.to - 3)
  await page.keyboard.type(' Zanzibar ')
  await docStart(page)
  await expect(indicator(page)).toHaveText(`Page 1 of ${(await layout(page)).pageCount}`)
  await page.keyboard.press('ControlOrMeta+f')
  const panel = page.getByRole('region', { name: 'Find and replace' })
  await panel.getByRole('textbox', { name: 'Find' }).fill('Zanzibar')
  await expect.poll(async () => (await spread(page)).index).toBe(5)
  const inside = await page.evaluate(() => {
    const el = document.querySelector('.novel-editor-content .nv-find-match-current')
    const s = document.querySelector('.nv-sizer')!.getBoundingClientRect()
    if (!el) return null
    const r = el.getBoundingClientRect()
    return r.top >= s.top && r.bottom <= s.bottom
  })
  expect(inside).toBe(true)
})

test('opening a footnote on another spread turns to it; footnote areas, heads and numbers render in Book mode', async ({ page }) => {
  await book(page)
  // A footnote near the end of page 5 (spread 4–5).
  const l = await layout(page)
  await page.evaluate((pos) => window.__nvE2E.selectText(pos, pos), l.pages[4].to - 5)
  await page.keyboard.press('ControlOrMeta+Alt+f')
  await expect(page.getByTestId('footnote-editor')).toBeFocused()
  await page.keyboard.type('A note on page five.')
  await page.keyboard.press('Escape')
  await waitForLayout(page)
  const area = page.locator('.nv-frames .nv-fn-area')
  await expect(area.first()).toBeVisible()
  // Away to the first spread, then select the reference (find) and open it with Enter.
  await docStart(page)
  await expect(indicator(page)).toContainText('Page 1 of')
  const ref = await page.evaluate(() => {
    const el = document.querySelector('.ProseMirror [data-footnote-ref]')!
    return window.__nvE2E.revealElement(el)
  })
  expect(ref).toBe(true)
  await expect.poll(async () => (await spread(page)).first).toBeGreaterThanOrEqual(3)
  await editor(page).locator('[data-footnote-ref]').click()
  await expect(page.getByTestId('footnote-popover')).toBeVisible()
  const popover = (await page.getByTestId('footnote-popover').boundingBox())!
  const sizer = (await page.locator('.nv-sizer').boundingBox())!
  expect(popover.y).toBeGreaterThanOrEqual(sizer.y - 1)
  expect(popover.y).toBeLessThanOrEqual(sizer.y + sizer.height)
  await page.keyboard.press('Escape')
  // Running heads / page numbers are drawn on the pages shown.
  await expect(page.locator('.nv-frames [data-hf="number"]').first()).toBeAttached()
})

test('comments margin panel shows the shown spread\'s comments; Next Comment turns to the next one', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  await launch(page)
  const ps = paragraphs(40)
  const content = ps.map((t, i) =>
    i === 2 || i === 30
      ? { type: 'paragraph', content: [{ type: 'text', text: t.slice(0, 20), marks: [{ type: 'comment', attrs: { id: `c${i}` } }] }, { type: 'text', text: t.slice(20) }] }
      : { type: 'paragraph', content: [{ type: 'text', text: t }] },
  )
  const thread = (id: string, body: string) => ({
    id,
    createdAt: '2026-11-01T10:00:00.000Z',
    author: 'Author',
    resolved: false,
    messages: [{ id: `${id}-m`, author: 'Author', date: '2026-11-01T10:00:00.000Z', text: body }],
  })
  await seedProject(page, '/projects/Notes', 'Notes', { type: 'doc', content })
  await writeFile(page, '/projects/Notes/comments.json', JSON.stringify({ version: 1, threads: [thread('c2', 'Early note'), thread('c30', 'Late note')] }))
  await openRecent(page, '/projects/Notes')
  await expect(saveStatus(page)).toHaveText('Notes: All changes saved')
  await waitForLayout(page)
  const panel = page.getByTestId('comments-panel')
  await expect(panel).toBeVisible()
  await expect(panel).toContainText('Early note')
  await expect(panel).not.toContainText('Late note')
  // Next Comment (twice from the start: the early one, then the late one) turns to the late spread.
  await ctl(page, 'comment.next').click()
  await ctl(page, 'comment.next').click()
  await expect(panel).toContainText('Late note')
  await expect(panel).not.toContainText('Early note')
  const anchor = page.locator('.novel-editor-content [data-comment-id="c30"], .novel-editor-content span[class*="comment"]').last()
  void anchor
  // The card sits level with its anchor, inside the spread shown.
  const card = panel.locator('.nv-comment-slot').first()
  const cardBox = (await card.boundingBox())!
  const sizer = (await page.locator('.nv-sizer').boundingBox())!
  expect(cardBox.y).toBeGreaterThanOrEqual(sizer.y - 2)
  expect(cardBox.y).toBeLessThan(sizer.y + sizer.height)
  // Book mode: a press on the panel never turns the page.
  if (await desk(page).getAttribute('data-navigation') === 'book') {
    const before = await spread(page)
    await panel.click({ position: { x: 150, y: 400 } })
    expect(await spread(page)).toEqual(before)
  }
})

test('header double-click on a spread turned to by hand opens the dialog without turning away', async ({ page }) => {
  const pageCount = await book(page)
  await docStart(page)
  await nextCtl(page).click()
  await nextCtl(page).click()
  await expect(indicator(page)).toHaveText(`Pages 4–5 of ${pageCount}`)
  const slot = page.locator('.nv-frames .nv-page[data-page-index="4"] .nv-slot-header')
  const box = (await slot.boundingBox())!
  await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2)
  await expect(page.getByRole('dialog', { name: 'Headers & page numbers' })).toBeVisible()
  await expect(indicator(page)).toHaveText(`Pages 4–5 of ${pageCount}`)
  await page.keyboard.press('Escape')
  if (await page.getByRole('dialog').count()) await page.keyboard.press('Escape')
  await expect(indicator(page)).toHaveText(`Pages 4–5 of ${pageCount}`)
})

test('single page view and a narrow window: one page per turn, controls still there', async ({ page }) => {
  const pageCount = await book(page)
  await page.evaluate(() => window.__nvE2E.setBookView('single'))
  await expect.poll(async () => (await layout(page)).effectiveView).toBe('single')
  await nextCtl(page).click()
  await expect(indicator(page)).toHaveText(`Page 2 of ${pageCount}`)
  expect(await shownSpreadDrawn(page)).toEqual({ frames: 1, inside: true, stale: 0 })
  await page.evaluate(() => window.__nvE2E.setBookView('spread'))
  await expect(indicator(page)).toHaveText(`Pages 2–3 of ${pageCount}`)
  // Narrow: falls back to single pages; the controls fit beside the page.
  await page.setViewportSize({ width: 620, height: 800 })
  await expect.poll(async () => (await layout(page)).effectiveView).toBe('single')
  await expect(nextCtl(page)).toBeInViewport()
  await expect(prevCtl(page)).toBeInViewport()
  await nextCtl(page).click()
  await expect(indicator(page)).toHaveText(`Page 3 of ${pageCount}`)
  const n = (await nextCtl(page).boundingBox())!
  const s = (await page.locator('.nv-sizer').boundingBox())!
  expect(n.x).toBeGreaterThanOrEqual(s.x + s.width - 1) // never over the page
  expect(n.width).toBeGreaterThanOrEqual(32)
  expect(n.height).toBeGreaterThanOrEqual(32)
})

test('Continuous Scroll persists across restarts and behaves as in Phase 2', async ({ page }) => {
  await book(page, 30)
  await chooseScrollNavigation(page)
  // The preference is written (debounced) to preferences.json.
  await expect.poll(() => page.evaluate(() => window.__nvE2E.preferencesFile()), { timeout: 5000 }).toContain('"pageNavigation": "scroll"')
  await launch(page) // relaunch
  await expect.poll(() => page.evaluate(() => window.__nvE2E.pageNavigation())).toBe('scroll')
  await expect(desk(page)).toHaveAttribute('data-navigation', 'scroll')
  await paste(page, paragraphs(30))
  const pageCount = (await layout(page)).pageCount
  // Scrolling changes the visible spread (no page turns).
  const main = page.getByRole('main', { name: 'Editor' })
  await main.evaluate((m) => m.scrollBy(0, 2600))
  await expect.poll(async () => (await spread(page)).index).toBeGreaterThan(1)
  await expect(indicator(page)).not.toHaveText(`Page 1 of ${pageCount}`)
  // Back to Book from Settings is the same preference.
  await page.evaluate(() => window.__nvE2E.setPageNavigation('book'))
  await expect(desk(page)).toHaveAttribute('data-navigation', 'book')
  await expect.poll(() => main.evaluate((m) => m.scrollHeight - m.clientHeight)).toBeLessThanOrEqual(2)
})

test('turn controls: tooltips on hover and keyboard focus; the coverage audit passes', async ({ page }) => {
  await book(page, 20)
  await nextCtl(page).hover()
  await expect(page.locator('[data-tooltip-body]')).toContainText('Next pages')
  await page.mouse.move(700, 10)
  // Keyboard: Tab from the previous control reaches the next one.
  await prevCtl(page).focus()
  await page.keyboard.press('Tab')
  await expect(nextCtl(page)).toBeFocused()
  await expect(page.locator('[data-tooltip-body]')).toContainText('Next pages')
  expect(await page.evaluate(() => window.__nvE2E.auditTooltips())).toEqual([])
})

/** Dispatch a synthetic wheel stream on the desk: `deltas[i]` every 16 ms. Resolves with how many were prevented. */
async function wheelStream(page: Page, deltas: number[], axis: 'x' | 'y' = 'y') {
  return desk(page).evaluate(
    async (el, [ds, ax]) => {
      const r = el.getBoundingClientRect()
      let prevented = 0
      for (const d of ds as number[]) {
        const e = new WheelEvent('wheel', {
          deltaX: ax === 'x' ? d : 0,
          deltaY: ax === 'y' ? d : 0,
          clientX: r.left + r.width / 2,
          clientY: r.top + 200,
          bubbles: true,
          cancelable: true,
        })
        el.dispatchEvent(e)
        if (e.defaultPrevented) prevented++
        await new Promise((res) => setTimeout(res, 16))
      }
      return prevented
    },
    [deltas, axis] as const,
  )
}

const decay = (n: number, peak: number, tau: number) => Array.from({ length: n }, (_, i) => Math.max(1, peak * Math.exp(-i / tau)))

test('wheel: a long momentum tail (~1.2 s) turns once; a new flick inside a decaying stream turns again', async ({ page }) => {
  const pageCount = await book(page)
  // 75 events over 1.2 s, smoothly decaying: one gesture.
  await wheelStream(page, decay(75, 90, 20))
  await expect(indicator(page)).toHaveText(`Pages 2–3 of ${pageCount}`)
  await page.waitForTimeout(400)
  expect((await spread(page)).index).toBe(1)
  // A flick, its momentum decaying, then a second strong flick before the stream stops: two turns.
  const ramp = [15, 40, 80, 90]
  await wheelStream(page, [...ramp, ...decay(30, 90, 6), ...ramp, ...decay(30, 90, 6)])
  await expect(indicator(page)).toHaveText(`Pages 6–7 of ${pageCount}`)
  await page.waitForTimeout(400)
  expect((await spread(page)).index).toBe(3)
})

test('wheel: zoomed in past the window width, a horizontal gesture pans the spread and turns only from its edge', async ({ page }) => {
  const pageCount = await book(page)
  await page.locator('[data-control-id="pagination.zoom"]').selectOption('200')
  await expect.poll(async () => (await layout(page)).scale).toBe(2)
  const main = page.getByRole('main', { name: 'Editor' })
  expect(await main.evaluate((m) => m.scrollWidth - m.clientWidth)).toBeGreaterThan(100)
  await main.evaluate((m) => (m.scrollLeft = 0))
  // Panning right from the left edge: the browser scrolls (nothing prevented), no turn.
  expect(await wheelStream(page, decay(20, 40, 8), 'x')).toBe(0)
  await page.waitForTimeout(300)
  expect((await spread(page)).index).toBe(0)
  // At the right edge, a new gesture turns.
  await main.evaluate((m) => (m.scrollLeft = m.scrollWidth))
  await page.waitForTimeout(300)
  expect(await wheelStream(page, decay(20, 40, 8), 'x')).toBeGreaterThan(0)
  await expect(indicator(page)).toHaveText(`Pages 2–3 of ${pageCount}`)
  // Turning back while zoomed in lands at the bottom of the previous spread (where reading went on).
  await main.evaluate((m) => (m.scrollTop = 0))
  await page.waitForTimeout(300)
  await prevCtl(page).click()
  await expect(indicator(page)).toHaveText(`Page 1 of ${pageCount}`)
  expect(await main.evaluate((m) => m.scrollHeight - m.clientHeight - m.scrollTop)).toBeLessThanOrEqual(2)
})

test('the page indicator is a button that opens Go to Page (pointer and keyboard), with a tooltip', async ({ page }) => {
  const pageCount = await book(page)
  await indicator(page).hover()
  await expect(page.locator('[data-tooltip-body]')).toContainText('Go to page')
  await indicator(page).click()
  const field = page.locator('[data-control-id="goToPage.number"]')
  await expect(field).toBeVisible()
  await field.fill('9')
  await page.keyboard.press('Enter')
  await expect(indicator(page)).toHaveText(`Pages 8–9 of ${pageCount}`)
  // Keyboard: focus it and press Enter. (The full text is a span inside the button, which also holds
  // the short "12 / 384" form for a narrow status bar.)
  await page.locator('footer [data-control-id="pagination.pageIndicator"]').focus()
  await page.keyboard.press('Enter')
  await expect(field).toBeVisible()
  await page.keyboard.press('Escape')
  if (await field.count()) await page.keyboard.press('Escape')
  await expect(field).toHaveCount(0)
})
