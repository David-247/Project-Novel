import { expect, test, type Page } from '@playwright/test'
import { waitForLayout } from './helpers'

/**
 * Paginated view (Phase 2, docs/pagination.md): one editor view laid out as book pages, in a
 * two-page spread by default. Book settings without their UI (the book settings ticket) are driven
 * through window.__nvE2E.
 */

const editor = (page: Page) => page.getByRole('textbox', { name: 'Manuscript' })
const layout = (page: Page) => page.evaluate(() => window.__nvE2E.layout())
const indicator = (page: Page) => page.getByTestId('page-indicator')
const frame = (page: Page, i: number) => page.locator(`.nv-frames .nv-page[data-page-index="${i}"]`)

const WORDS = 'night river quiet lantern stone window garden letter morning shadow silver harbor whisper meadow'.split(' ')
/** `count` paragraphs of varied length (about `words` words on average). */
function paragraphs(count: number, words = 100) {
  let n = 0
  return Array.from({ length: count }, (_, i) => {
    const len = Math.max(8, Math.round(words * (0.4 + ((i * 37) % 13) / 10)))
    return Array.from({ length: len }, () => WORDS[(n++ * 5) % WORDS.length]).join(' ')
  })
}

/** Paste plain text (paragraphs separated by blank lines) into the empty editor. */
async function paste(page: Page, blocks: string[]) {
  await page.goto('/')
  await editor(page).click()
  await editor(page).evaluate((el, text) => {
    const data = new DataTransfer()
    data.setData('text/plain', text)
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  }, blocks.join('\n\n'))
  await waitForLayout(page)
}

/** Lines (client rects grouped by top) of the element's text, and the page frame each lies in. */
async function linesByPage(page: Page, selector: string) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel)!
    const r = document.createRange()
    r.selectNodeContents(el)
    const frames = Array.from(document.querySelectorAll<HTMLElement>('.nv-frames .nv-page')).map((f) => ({
      index: Number(f.dataset.pageIndex),
      rect: f.getBoundingClientRect(),
    }))
    const tops = new Map<number, number>()
    for (const rc of Array.from(r.getClientRects())) {
      if (rc.height === 0 || rc.width === 0) continue
      const top = Math.round(rc.top)
      if (tops.has(top)) continue
      const f = frames.find((fr) => rc.left >= fr.rect.left - 1 && rc.right <= fr.rect.right + 1 && rc.top >= fr.rect.top - 1 && rc.bottom <= fr.rect.bottom + 1)
      tops.set(top, f ? f.index : -1)
    }
    return [...tops.values()]
  }, selector)
}

test('a pasted 100k-word manuscript flows across a two-page spread, splitting paragraphs at line boundaries', async ({ page }) => {
  test.setTimeout(90_000)
  await page.setViewportSize({ width: 1400, height: 900 })
  await paste(page, paragraphs(1000))
  const l = await layout(page)
  expect(l.effectiveView).toBe('spread')
  expect(l.pageCount).toBeGreaterThan(300)
  expect(l.pages[0]).toMatchObject({ index: 0, side: 'recto', from: 0 })
  expect(l.pages[1].side).toBe('verso')
  // Pages tile the document.
  for (let i = 1; i < l.pages.length; i++) expect(l.pages[i].from).toBe(l.pages[i - 1].to)
  // Many pages start in the middle of a paragraph: paragraphs split, they are not pushed whole.
  expect(l.pages.filter((p) => !p.isBlank && p.startsBlockType === null).length).toBeGreaterThan(l.pageCount / 3)
  await expect(indicator(page)).toHaveText(`Page 1 of ${l.pageCount}`)

  // Page 1 is a recto on its own; pages 2 and 3 face each other and touch at the spine.
  const [p0, p1, p2] = [await frame(page, 0).boundingBox(), await frame(page, 1).boundingBox(), await frame(page, 2).boundingBox()]
  expect(p0!.x).toBeGreaterThan(p1!.x + p1!.width / 2)
  expect(p1!.y).toBeCloseTo(p2!.y, 0)
  expect(p2!.x).toBeCloseTo(p1!.x + p1!.width, 0)

  // The first paragraph that continues on the next page: its lines sit inside the two page frames,
  // with at least two lines on each (widows / orphans), and nothing in between.
  const pagesOfLines = await linesByPage(page, 'p:has(> span.nv-shift)')
  expect(pagesOfLines).not.toContain(-1)
  const distinct = [...new Set(pagesOfLines)]
  expect(distinct.length).toBeGreaterThanOrEqual(2)
  expect(distinct[1]).toBe(distinct[0] + 1)
  for (const pg of distinct) expect(pagesOfLines.filter((x) => x === pg).length).toBeGreaterThanOrEqual(2)
})

test('typing, selection across pages, undo and find work on any page; PageDown moves by spread', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  await paste(page, paragraphs(40, 100))
  const { pageCount } = await layout(page)
  expect(pageCount).toBeGreaterThan(8)
  // Let the paste close its undo group (typing within 500 ms of it would join it).
  await page.waitForTimeout(600)

  // PageDown: next spread (pages 2-3), caret on its first page and visible; the indicator follows.
  await page.keyboard.press('ControlOrMeta+Home')
  await page.keyboard.press('PageDown')
  await expect.poll(async () => (await layout(page)).currentPage).toBe(1)
  await expect(indicator(page)).toHaveText(`Pages 2–3 of ${pageCount}`)
  await page.keyboard.press('PageDown')
  await expect.poll(async () => (await layout(page)).currentPage).toBe(3)
  await expect(indicator(page)).toHaveText(`Pages 4–5 of ${pageCount}`)
  const caretVisible = () =>
    page.evaluate(() => {
      const s = getSelection()!
      const r = document.createRange()
      r.setStart(s.focusNode!, s.focusOffset)
      r.setEnd(s.focusNode!, Math.min(s.focusOffset + 1, s.focusNode!.textContent!.length))
      const rects = Array.from(r.getClientRects()).filter((x) => x.height > 0)
      if (!rects.length) return false
      const rc = rects[rects.length - 1]
      const m = document.querySelector('main')!.getBoundingClientRect()
      return rc.top >= m.top && rc.bottom <= m.bottom
    })
  expect(await caretVisible()).toBe(true)
  await page.keyboard.press('PageUp')
  await expect.poll(async () => (await layout(page)).currentPage).toBe(1)

  // Type on page 2 (a few lines down: text typed at the very top of a page that starts mid-paragraph
  // may legitimately fit on the previous page's last line).
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowDown')
  await page.keyboard.press('End')
  await page.keyboard.type(' Zebra')
  await expect(editor(page)).toContainText('Zebra')
  await waitForLayout(page)
  expect((await layout(page)).currentPage).toBe(1)

  // Find scrolls a match on a later page into view.
  await page.keyboard.press('ControlOrMeta+Home')
  await page.keyboard.press('ControlOrMeta+f')
  await page.getByRole('textbox', { name: 'Find' }).fill('Zebra')
  await expect(page.getByTestId('find-status')).toHaveText('1 of 1')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Escape')
  await expect.poll(async () => (await layout(page)).currentPage).toBe(1)

  // Undo takes the typing back.
  await page.keyboard.press('ControlOrMeta+z')
  await expect(editor(page)).not.toContainText('Zebra')

  // A selection across a page boundary (Shift+PageDown) deletes as one range.
  await page.keyboard.press('ControlOrMeta+Home')
  await page.keyboard.press('Shift+PageDown')
  await page.keyboard.press('Shift+PageDown')
  await page.keyboard.press('Delete')
  await waitForLayout(page)
  expect((await layout(page)).pageCount).toBeLessThan(pageCount - 1)
  await page.keyboard.press('ControlOrMeta+z')
  await waitForLayout(page)
  expect((await layout(page)).pageCount).toBe(pageCount)
})

test("breakBefore 'page' and 'recto' (data-break-before contract) start chapters on a new page / the next recto", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  await page.goto('/')
  await editor(page).click()
  for (const ch of ['One', 'Two', 'Three']) {
    await page.keyboard.type(`# Chapter ${ch}`)
    await page.keyboard.press('Enter')
    await page.keyboard.type('A short paragraph.')
    await page.keyboard.press('Enter')
  }
  await waitForLayout(page)
  // The Chapter Title style (styles ticket) already emits data-break-before="page" on each level-1 heading.
  await expect(editor(page).locator('h1').nth(1)).toHaveAttribute('data-break-before', 'page')
  let l = await layout(page)
  expect(l.pageCount).toBe(3)
  expect(l.pages.map((p) => [p.startsBlockType, p.isBlank, p.chapterIndex])).toEqual([
    ['heading', false, 0],
    ['heading', false, 1],
    ['heading', false, 2],
  ])

  await page.evaluate(() => window.__nvE2E.breakBeforeBlocks({ type: 'heading', level: 1 }, 'recto'))
  await waitForLayout(page)
  l = await layout(page)
  // Chapter 2 would start on page 2 (a verso): page 2 is left blank. Same for chapter 3.
  expect(l.pages.map((p) => (p.isBlank ? 'blank' : `${p.side}:${p.chapterIndex}`))).toEqual([
    'recto:0',
    'blank',
    'recto:1',
    'blank',
    'recto:2',
  ])
  // The heading is painted on its page.
  const h = await editor(page).locator('h1').nth(2).boundingBox()
  const f = await frame(page, 4).boundingBox()
  expect(h!.x).toBeGreaterThan(f!.x)
  expect(h!.y).toBeGreaterThan(f!.y)
  expect(h!.y + h!.height).toBeLessThan(f!.y + f!.height)

  // Back to the style's own breaks.
  await page.evaluate(() => window.__nvE2E.breakBeforeBlocks(null))
  await waitForLayout(page)
  expect((await layout(page)).pageCount).toBe(3)
})

test('a narrow window or book.view single shows one page at a time', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  await paste(page, paragraphs(12))
  const { pageCount } = await layout(page)
  await expect(page.locator('.nv-frames .nv-page').first()).toHaveAttribute('data-view', 'spread')

  await page.setViewportSize({ width: 500, height: 800 })
  await expect.poll(async () => (await layout(page)).effectiveView).toBe('single')
  await expect(page.locator('.nv-frames .nv-page').first()).toHaveAttribute('data-view', 'single')
  await page.keyboard.press('ControlOrMeta+Home')
  await expect(indicator(page)).toHaveText(`Page 1 of ${pageCount}`)
  // Single pages stack vertically; text stays on its page.
  const [a, b] = [await frame(page, 0).boundingBox(), await frame(page, 1).boundingBox()]
  expect(b!.x).toBeCloseTo(a!.x, 0)
  expect(b!.y).toBeGreaterThan(a!.y + a!.height)
  await page.keyboard.press('PageDown')
  await expect(indicator(page)).toHaveText(`Page 2 of ${pageCount}`)

  await page.setViewportSize({ width: 1400, height: 900 })
  await expect.poll(async () => (await layout(page)).effectiveView).toBe('spread')

  // The spread toggle (book.view).
  const toggle = page.locator('[data-control-id="pagination.spreadView"]')
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await expect.poll(async () => (await layout(page)).effectiveView).toBe('single')
  await toggle.press('Enter')
  await expect.poll(async () => (await layout(page)).effectiveView).toBe('spread')
  // Page breaks do not depend on the view.
  await waitForLayout(page)
  expect((await layout(page)).pageCount).toBe(pageCount)
})

test('zoom: fit spread, fit width and percentage steps', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  await paste(page, paragraphs(12))
  const zoom = page.locator('[data-control-id="pagination.zoom"]')
  await expect(zoom).toHaveValue('fit-spread')
  const fitSpread = (await layout(page)).scale
  // The whole first page fits the window height.
  const f0 = await frame(page, 0).boundingBox()
  const main = await page.getByRole('main', { name: 'Editor' }).boundingBox()
  expect(f0!.height).toBeLessThanOrEqual(main!.height)

  await zoom.selectOption('fit-width')
  await expect.poll(async () => (await layout(page)).scale).toBeGreaterThan(fitSpread)
  await page.locator('[data-control-id="pagination.zoomIn"]').click()
  await expect(zoom).toHaveValue(/^\d+$/)
  await zoom.selectOption('100')
  await expect.poll(async () => (await layout(page)).scale).toBe(1)
  await expect.poll(async () => Math.round((await frame(page, 0).boundingBox())!.width)).toBe(528)
  await page.locator('[data-control-id="pagination.zoomOut"]').click()
  await expect(zoom).toHaveValue('75')
  await expect.poll(async () => (await layout(page)).scale).toBe(0.75)
  // Zoom never changes the page breaks.
  const before = (await layout(page)).pages.map((p) => p.from)
  await zoom.selectOption('150')
  await waitForLayout(page)
  expect((await layout(page)).pages.map((p) => p.from)).toEqual(before)
})

test('trim size reflows; margins mirror on verso and recto; bottom reservations push text on', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  await paste(page, paragraphs(30))
  await page.locator('[data-control-id="pagination.zoom"]').selectOption('100')
  await waitForLayout(page)
  const small = await layout(page)

  await page.evaluate(() => window.__nvE2E.setTrimSize('us-6x9'))
  await waitForLayout(page)
  const big = await layout(page)
  expect(big.pageCount).toBeLessThan(small.pageCount)
  expect(Math.round((await frame(page, 0).boundingBox())!.width)).toBe(576)

  // Mirrored margins: the text of a verso starts 45pt (60px) from its left edge, a recto's 63pt (84px).
  const leftOfText = async (i: number) => {
    const f = (await frame(page, i).boundingBox())!
    const x = await page.evaluate((idx) => {
      const fr = document.querySelector(`.nv-frames .nv-page[data-page-index="${idx}"]`)!.getBoundingClientRect()
      const r = document.createRange()
      let min = Infinity
      for (const p of Array.from(document.querySelectorAll('.ProseMirror p'))) {
        r.selectNodeContents(p)
        for (const rc of Array.from(r.getClientRects()))
          if (rc.width > 0 && rc.top >= fr.top && rc.bottom <= fr.bottom && rc.left >= fr.left && rc.right <= fr.right) min = Math.min(min, rc.left)
      }
      return min
    }, i)
    return Math.round(x - f.x)
  }
  await editor(page).focus()
  await page.keyboard.press('ControlOrMeta+Home')
  await page.keyboard.press('PageDown')
  await waitForLayout(page)
  expect(await leftOfText(1)).toBe(60)
  expect(await leftOfText(2)).toBe(84)

  // Footnote stand-in: reserve 300px at the bottom of the page holding position 5.
  const before = (await layout(page)).pages[0].to
  await page.evaluate(() => window.__nvE2E.reserveBottom(5, 300))
  await waitForLayout(page)
  const after = await layout(page)
  expect(after.pages[0].to).toBeLessThan(before)
  expect(await page.evaluate(() => window.__nvE2E.paginationReserved()[0])).toBe(300)
  await page.evaluate(() => window.__nvE2E.reserveBottom(null))
  await waitForLayout(page)
  expect((await layout(page)).pages[0].to).toBe(before)
})

test('a press on a margin or the desk puts the caret on the nearest line of that page', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  await paste(page, paragraphs(12))
  await page.locator('[data-control-id="pagination.zoom"]').selectOption('100')
  await waitForLayout(page)
  await frame(page, 2).scrollIntoViewIfNeeded()
  const f = (await frame(page, 2).boundingBox())!
  // Bottom margin of page 3 (a recto), then type.
  await page.mouse.click(f.x + f.width / 2, f.y + f.height - 20)
  await page.keyboard.type('Q')
  await waitForLayout(page)
  const l = await layout(page)
  expect(l.currentPage).toBe(2)
  const text = await page.evaluate(() => document.querySelector('.ProseMirror')!.textContent!)
  expect(text).toContain('Q')
})
