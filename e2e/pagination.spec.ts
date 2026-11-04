import { expect, test, type Page } from '@playwright/test'
import { clickBlockStart, docEnd, docStart, lineEnd, waitForLayout } from './helpers'

/**
 * Paginated view (Phase 2, docs/pagination.md): one editor view laid out as book pages, in a
 * two-page spread by default. Book settings without their UI (the book settings ticket) are driven
 * through window.__nvE2E.
 */

declare global {
  interface Window {
    /** Starts the per-frame paint sampler (samplePaints). */
    __nvArm?: () => void
  }
}

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
  await docStart(page)
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
  await lineEnd(page)
  await page.keyboard.type(' Zebra')
  await expect(editor(page)).toContainText('Zebra')
  await waitForLayout(page)
  expect((await layout(page)).currentPage).toBe(1)

  // Find scrolls a match on a later page into view.
  await docStart(page)
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
  await docStart(page)
  await expect.poll(async () => (await layout(page)).currentPage).toBe(0)
  await page.keyboard.press('Shift+PageDown')
  await expect.poll(async () => (await layout(page)).currentPage).toBe(1)
  await page.keyboard.press('Shift+PageDown')
  await expect.poll(async () => (await layout(page)).currentPage).toBe(3)
  // The selection runs from the start of the book to the top of page 4.
  expect(await page.evaluate(() => getSelection()!.toString().length)).toBeGreaterThan(2000)
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
  await docStart(page)
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
  await docStart(page)
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
  // A reservation change re-breaks pages from the measured lines: nothing is re-measured.
  expect((await page.evaluate(() => window.__nvE2E.paginationLines())).lastPass.measuredBlocks).toBe(0)
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

/** Pages tile the document and the model is settled. */
async function expectTiled(page: Page) {
  await waitForLayout(page)
  const l = await layout(page)
  expect(l.pages[0].from).toBe(0)
  for (let i = 1; i < l.pages.length; i++) expect(l.pages[i].from).toBe(l.pages[i - 1].to)
  return l
}

test('Replace and Replace All on a later page reflow the book', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  await paste(page, paragraphs(40, 100))
  await page.waitForTimeout(600) // own undo group
  // A unique word on page 4 (index 3): two spreads down, a few lines in.
  await docStart(page)
  await page.keyboard.press('PageDown')
  await page.keyboard.press('PageDown')
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowDown')
  await lineEnd(page)
  await page.keyboard.type(' Quokka')
  await waitForLayout(page)
  expect((await layout(page)).currentPage).toBeGreaterThanOrEqual(3)
  const before = await layout(page)

  await docStart(page)
  await page.keyboard.press('ControlOrMeta+f')
  const panel = page.getByRole('region', { name: 'Find and replace' })
  await panel.getByRole('textbox', { name: 'Find' }).fill('Quokka')
  await expect(page.getByTestId('find-status')).toHaveText('1 of 1')
  await panel.getByRole('textbox', { name: 'Replace with' }).fill('Quokka Quokka Quokka')
  await panel.locator('[data-control-id="find.replace"]').click()
  let l = await expectTiled(page)
  expect(await editor(page).evaluate((el) => el.textContent!.includes('Quokka Quokka Quokka'))).toBe(true)
  // The edit is on page 4 or later: the first three pages did not move.
  expect(l.pages[3].from).toBe(before.pages[3].from)

  // Replace All of a common word shortens every page's text: the book reflows and stays tiled.
  await panel.getByRole('textbox', { name: 'Find' }).fill('meadow')
  await expect(page.getByTestId('find-status')).toHaveText(/ of \d+$/)
  await panel.getByRole('textbox', { name: 'Replace with' }).fill('')
  await panel.locator('[data-control-id="find.replaceAll"]').click()
  await expect(page.getByTestId('find-status')).toHaveText(/^Replaced \d+$/)
  l = await expectTiled(page)
  expect(l.pageCount).toBeLessThan(before.pageCount)
  expect(await editor(page).evaluate((el) => el.textContent!.includes('meadow'))).toBe(false)
})

test('IME composition inside a split paragraph: no reflow until it ends, then the book reflows', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Input.imeSetComposition is a Chromium DevTools protocol call')
  await page.setViewportSize({ width: 1400, height: 900 })
  await paste(page, paragraphs(30, 100))
  // Caret at the end of the first line of the first paragraph that continues on the next page.
  const idx = await editor(page).evaluate((root) => {
    const ps = Array.from(root.querySelectorAll(':scope > p'))
    return ps.findIndex((p) => p.querySelector(':scope > span.nv-shift'))
  })
  expect(idx).toBeGreaterThanOrEqual(0)
  await clickBlockStart(page, editor(page).locator(':scope > p').nth(idx))
  await lineEnd(page)
  await waitForLayout(page)

  const cdp = await page.context().newCDPSession(page)
  const compose = (text: string) => cdp.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length })
  await compose('k')
  await compose('ka')
  await compose('か')
  await compose('かんじかんじかんじ')
  // While composing, the pass waits (redrawing under the composition would break it).
  await page.waitForTimeout(150)
  expect(await page.evaluate(() => window.__nvE2E.paginationSettled())).toBe(false)
  await cdp.send('Input.insertText', { text: '漢字漢字漢字' })
  const l = await expectTiled(page)
  expect(await editor(page).evaluate((el) => el.textContent!.includes('漢字漢字漢字'))).toBe(true)
  expect(l.pageCount).toBeGreaterThan(5)
})

test('ArrowDown / ArrowUp across a page split keep the caret column', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  await paste(page, paragraphs(30, 100))
  await page.locator('[data-control-id="pagination.zoom"]').selectOption('100')
  await waitForLayout(page)
  // The last head line of the first paragraph that continues on the next page.
  await editor(page).evaluate((root) => {
    const p = Array.from(root.querySelectorAll(':scope > p')).find((el) => el.querySelector(':scope > span.nv-shift'))!
    p.scrollIntoView({ block: 'center' })
  })
  const caretInfo = () =>
    page.evaluate(() => {
      const s = getSelection()!
      const r = document.createRange()
      r.setStart(s.focusNode!, s.focusOffset)
      const rc = r.getClientRects()[0] ?? r.getBoundingClientRect()
      const frames = Array.from(document.querySelectorAll<HTMLElement>('.nv-frames .nv-page'))
      const f = frames.find((fr) => {
        const b = fr.getBoundingClientRect()
        return rc.left >= b.left && rc.left <= b.right && rc.top >= b.top && rc.bottom <= b.bottom
      })
      return { page: f ? Number(f.dataset.pageIndex) : -1, xInPage: f ? rc.left - f.getBoundingClientRect().left : -1 }
    })
  const point = await editor(page).evaluate((root) => {
    const p = Array.from(root.querySelectorAll(':scope > p')).find((el) => el.querySelector(':scope > span.nv-shift'))!
    const head = Array.from(p.childNodes).filter((n) => !(n instanceof HTMLElement && n.classList.contains('nv-shift')))
    const r = document.createRange()
    let best: DOMRect | null = null
    for (const n of head) {
      r.selectNodeContents(n)
      for (const rc of Array.from(r.getClientRects())) if (rc.width > 0 && (!best || rc.top > best.top)) best = rc
    }
    return { x: best!.left + best!.width / 2, y: best!.top + best!.height / 2 }
  })
  await page.mouse.click(point.x, point.y)
  await waitForLayout(page)
  const start = await caretInfo()
  expect(start.page).toBeGreaterThanOrEqual(0)

  await page.keyboard.press('ArrowDown')
  await expect.poll(async () => (await caretInfo()).page).toBe(start.page + 1)
  const down = await caretInfo()
  // Same column, mirrored margins aside (verso and recto text blocks start at different x).
  const shift = (start.page % 2 === 0 ? 84 - 60 : 60 - 84) // recto -> verso moves the text block left
  expect(Math.abs(down.xInPage - (start.xInPage - shift))).toBeLessThan(30)
  expect((await layout(page)).currentPage).toBe(start.page + 1)

  await page.keyboard.press('ArrowUp')
  await expect.poll(async () => (await caretInfo()).page).toBe(start.page)
  expect(Math.abs((await caretInfo()).xInPage - start.xInPage)).toBeLessThan(30)
})

test('at fit-spread, ArrowDown on a recto last line reaches the next row verso below the viewport', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 800 })
  await paste(page, paragraphs(30, 100))
  await expect(page.locator('[data-control-id="pagination.zoom"]')).toHaveValue('fit-spread')
  await frame(page, 2).scrollIntoViewIfNeeded()
  // The last painted line of page 3 (index 2, a recto).
  const point = await page.evaluate(() => {
    const fr = document.querySelector('.nv-frames .nv-page[data-page-index="2"]')!.getBoundingClientRect()
    const r = document.createRange()
    let best: DOMRect | null = null
    const walker = document.createTreeWalker(document.querySelector('.ProseMirror')!, NodeFilter.SHOW_TEXT)
    for (let t = walker.nextNode(); t; t = walker.nextNode()) {
      r.selectNodeContents(t)
      for (const rc of Array.from(r.getClientRects()))
        if (rc.width > 0 && rc.left >= fr.left && rc.right <= fr.right && rc.top >= fr.top && rc.bottom <= fr.bottom && (!best || rc.top > best.top)) best = rc
    }
    return { x: best!.left + Math.min(40, best!.width / 2), y: best!.top + best!.height / 2 }
  })
  await page.mouse.click(point.x, point.y)
  await waitForLayout(page)
  expect((await layout(page)).currentPage).toBe(2)
  // The next page (index 3, verso of the next row) starts below the viewport.
  const main = (await page.getByRole('main', { name: 'Editor' }).boundingBox())!
  expect((await frame(page, 3).boundingBox())!.y + 100).toBeGreaterThan(main.y + main.height)

  await page.keyboard.press('ArrowDown')
  await expect.poll(async () => (await layout(page)).currentPage).toBe(3)
  // The caret is on page 4's first line, scrolled into view.
  const caret = await page.evaluate(() => {
    const s = getSelection()!
    const r = document.createRange()
    r.setStart(s.focusNode!, s.focusOffset)
    const rc = r.getClientRects()[0] ?? r.getBoundingClientRect()
    const fr = document.querySelector('.nv-frames .nv-page[data-page-index="3"]')!.getBoundingClientRect()
    return { inFrame: rc.top >= fr.top && rc.bottom <= fr.top + fr.height / 3, top: rc.top, bottom: rc.bottom }
  })
  expect(caret.inFrame).toBe(true)
  expect(caret.top).toBeGreaterThanOrEqual(main.y)
  expect(caret.bottom).toBeLessThanOrEqual(main.y + main.height)
})

test('page break node: the next block starts a new page, and the break takes no line', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  await page.goto('/')
  await editor(page).click()
  await page.keyboard.type('Opening text')
  await page.keyboard.press('ControlOrMeta+Enter') // Insert > Page break
  await page.keyboard.type('After the break')
  await waitForLayout(page)
  const l = await layout(page)
  expect(l.pageCount).toBe(2)
  expect(l.pages[1].startsBlockType).toBe('paragraph')
  // The page break atom closes page 1 with zero height; the paragraph after it is painted on page 2.
  expect(await editor(page).locator('[data-page-break]').evaluate((el) => (el as HTMLElement).offsetHeight)).toBe(0)
  const after = (await editor(page).locator('p', { hasText: 'After the break' }).boundingBox())!
  const f1 = (await frame(page, 1).boundingBox())!
  expect(after.x).toBeGreaterThan(f1.x)
  expect(after.y).toBeGreaterThan(f1.y)
  expect(after.y + after.height).toBeLessThan(f1.y + f1.height)
})

test('Chapters start on right-hand page: a New chapter lands on a recto, with a blank verso before it', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  await page.goto('/')
  await editor(page).click()
  await page.keyboard.type('Front matter.')
  await page.keyboard.press('Enter')
  await page.keyboard.press('ControlOrMeta+Shift+Enter') // Insert > New chapter
  await page.keyboard.type('The Storm')
  await page.keyboard.press('Enter')
  await page.keyboard.type('It rained.')
  await waitForLayout(page)
  let l = await layout(page)
  // Next page (the default): the chapter opens on page 2, a verso.
  expect(l.pages.map((p) => (p.isBlank ? 'blank' : `${p.side}:${p.chapterIndex}`))).toEqual(['recto:-1', 'verso:0'])

  await page.locator('[data-control-id="insert.menu"]').click()
  await page.locator('[data-control-id="insert.chapterStart.recto"]').click()
  await waitForLayout(page)
  l = await layout(page)
  expect(l.pages.map((p) => (p.isBlank ? 'blank' : `${p.side}:${p.chapterIndex}`))).toEqual(['recto:-1', 'blank', 'recto:0'])
  expect(l.pages[2].startsBlockType).toBe('heading')
  const h = (await editor(page).locator('h1').boundingBox())!
  const f2 = (await frame(page, 2).boundingBox())!
  expect(h.x).toBeGreaterThan(f2.x)
  expect(h.y).toBeGreaterThan(f2.y)
})

/**
 * Sample, every animation frame, where each visible block is painted while `act` triggers a
 * wholesale reflow, until the engine has settled; then compare every sample with the final place.
 * Sampling starts when `act` calls `window.__nvArm()` in the page in the
 * same task as the trigger. Positions are in unscaled canvas px (fit-spread zoom changes with the
 * page height).
 */
async function samplePaints(page: Page, act: () => Promise<void>) {
  await page.evaluate(() => {
    const m = document.querySelector('main')!
    const root = document.querySelector('.ProseMirror')!
    const canvas = () => {
      const el = document.querySelector<HTMLElement>('.nv-canvas')!
      const r = el.getBoundingClientRect()
      return { left: r.left, top: r.top, s: r.width / el.offsetWidth }
    }
    const seen = new Map<Element, { f: number; x: number; y: number }[]>()
    const state = { frames: 0, hiding: 0, stop: false, armed: false, seen, canvas, v0: window.__nvE2E.layout().layoutVersion }
    // Sample what the frame paints: after every animation-frame callback of that frame (the
    // engine's pass may be queued after this one), i.e. in a task right after the frame.
    const tick = () => {
      if (state.stop) return
      requestAnimationFrame(tick)
      if (state.armed) setTimeout(sample, 0)
    }
    const sample = () => {
      if (state.stop) return
      state.frames++
      if (document.querySelector('.nv-stale, .nv-unmapped')) state.hiding++
      const v = m.getBoundingClientRect()
      const c = canvas()
      for (const el of Array.from(root.children)) {
        const r = el.getBoundingClientRect()
        if (r.bottom < v.top || r.top > v.bottom || r.height === 0) continue
        // Hidden while stale (nv-stale) or while the decorations are unmapped (nv-unmapped).
        if (getComputedStyle(el).visibility === 'hidden') continue
        const list = seen.get(el) ?? []
        list.push({ f: state.frames, x: (r.left - c.left) / c.s, y: (r.top - c.top) / c.s })
        seen.set(el, list)
      }
    }
    ;(window as unknown as { __nvSample: typeof state }).__nvSample = state
    window.__nvArm = () => {
      state.armed = true
    }
    requestAnimationFrame(tick)
  })
  await act()
  return page.evaluate(async () => {
    const state = (window as unknown as { __nvSample: { frames: number; hiding: number; stop: boolean; v0: number; seen: Map<Element, { f: number; x: number; y: number }[]>; canvas: () => { left: number; top: number; s: number } } }).__nvSample
    await new Promise<void>((resolve) => {
      const check = () =>
        window.__nvE2E.layout().layoutVersion > state.v0 && window.__nvE2E.paginationSettled() && !document.querySelector('.nv-unmapped')
          ? resolve()
          : requestAnimationFrame(check)
      requestAnimationFrame(check)
    })
    await new Promise((r) => requestAnimationFrame(() => r(null)))
    state.stop = true
    const c = state.canvas()
    const stale: string[] = []
    for (const [el, list] of state.seen) {
      if (!el.isConnected) continue
      const r = el.getBoundingClientRect()
      const fin = { x: (r.left - c.left) / c.s, y: (r.top - c.top) / c.s }
      for (const p of list) if (Math.abs(p.x - fin.x) > 1 || Math.abs(p.y - fin.y) > 1) stale.push(`frame ${p.f}: ${Math.round(p.y)}->${Math.round(fin.y)}`)
    }
    return { frames: state.frames, hiding: state.hiding, checked: state.seen.size, stale, hiddenLeft: document.querySelectorAll('.nv-stale').length }
  })
}

async function expectNoStalePaint(page: Page, act: () => Promise<void>, at = 0.5) {
  const main = page.getByRole('main', { name: 'Editor' })
  await main.evaluate((m, f) => (m.scrollTop = (m.scrollHeight - m.clientHeight) * f), at)
  await waitForLayout(page)
  const result = await samplePaints(page, act)
  expect(result.checked).toBeGreaterThan(0)
  // The progressive (nv-stale) or unmapped (nv-unmapped) path was taken: some frames hid blocks.
  expect(result.hiding).toBeGreaterThan(0)
  // Once settled, no block is left hidden.
  expect(result.hiddenLeft).toBe(0)
  expect(result.stale, `stale paints over ${result.frames} frames`).toEqual([])
}

for (const [trim, at] of [
  ['us-6x9', 0.5],
  ['us-5x8', 0.2],
  ['us-6x9', 0.8],
  ['us-5x8', 0.5],
] as const) {
  test(`progressive reflow never paints a block at a stale place (${trim}, scrolled to ${at * 100}%)`, async ({ page }) => {
    test.setTimeout(90_000)
    await page.setViewportSize({ width: 1400, height: 900 })
    await paste(page, paragraphs(1000, 60))
    await expectNoStalePaint(page, () => page.evaluate((id) => (window.__nvArm!(), window.__nvE2E.setTrimSize(id)), trim), at)
  })
}

test('progressive restyle never paints a block at a stale place (Body font size)', async ({ page }) => {
  test.setTimeout(90_000)
  await page.setViewportSize({ width: 1400, height: 900 })
  await paste(page, paragraphs(1000, 60))
  await expectNoStalePaint(page, async () => {
    // Every paragraph changes height: more blocks than the progressive threshold are re-measured.
    await editor(page).locator('p').nth(500).click()
    await waitForLayout(page)
    await page.locator('[data-control-id="styles.edit"]').click()
    const dialog = page.getByRole('dialog', { name: /^Modify style:/ })
    await dialog.locator('[data-control-id="styles.field.fontSize"]').fill('14')
    await dialog.locator('[data-control-id="styles.modify.save"]').evaluate((b: HTMLButtonElement) => (window.__nvArm!(), b.click()))
    await expect(dialog).toBeHidden()
  })
})

test('Replace All (unmapped decorations) never paints a block at a stale place', async ({ page }) => {
  test.setTimeout(90_000)
  await page.setViewportSize({ width: 1400, height: 900 })
  await paste(page, paragraphs(1000, 60))
  await page.keyboard.press('ControlOrMeta+f')
  const panel = page.getByRole('region', { name: 'Find and replace' })
  await panel.getByRole('textbox', { name: 'Find' }).fill('meadow')
  await expect(page.getByTestId('find-status')).toHaveText(/ of \d+$/)
  await panel.getByRole('textbox', { name: 'Replace with' }).fill('')
  await expectNoStalePaint(page, async () => {
    // Thousands of steps: over the mapping limit, so the decorations are dropped (nv-unmapped).
    await panel.locator('[data-control-id="find.replaceAll"]').evaluate((b: HTMLButtonElement) => (window.__nvArm!(), b.click()))
    await expect(page.getByTestId('find-status')).toHaveText(/^Replaced \d+$/)
  })
  expect(await editor(page).evaluate((el) => el.textContent!.includes('meadow'))).toBe(false)
})

test('a reflow requested while the editor has no size runs once it is shown again', async ({ page }) => {
  await paste(page, paragraphs(40, 60))
  const before = await layout(page)
  // Hide the manuscript (zero width), change the trim size, show it again: no edit follows.
  await page.evaluate(() => {
    document.querySelector<HTMLElement>('.ProseMirror')!.style.display = 'none'
    window.__nvE2E.setTrimSize('us-5x8')
  })
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
  await page.evaluate(() => (document.querySelector<HTMLElement>('.ProseMirror')!.style.display = ''))
  await expect.poll(async () => (await layout(page)).pageCount, { timeout: 5_000 }).toBeGreaterThan(before.pageCount)
  await expect.poll(() => page.evaluate(() => window.__nvE2E.paginationSettled())).toBe(true)
  expect(await page.evaluate(() => document.querySelectorAll('.nv-stale, .nv-unmapped').length)).toBe(0)
})

test('a node instance used twice is redrawn at both places after a progressive reflow', async ({ page }) => {
  test.setTimeout(90_000)
  await page.setViewportSize({ width: 1400, height: 900 })
  await paste(page, paragraphs(1000, 60))
  // Block 2 is in view (drawn first); its second place, at the end of the book, is drawn later.
  await page.evaluate(() => window.__nvE2E.appendSameBlock(2))
  await waitForLayout(page)
  await page.evaluate(() => window.__nvE2E.setTrimSize('us-5x8'))
  await expect.poll(() => page.evaluate(() => window.__nvE2E.paginationSettled()), { timeout: 30_000 }).toBe(true)
  expect(await page.evaluate(() => document.querySelectorAll('.nv-stale').length)).toBe(0)
})

test('find during a progressive reflow scrolls to where the match is painted', async ({ page }) => {
  test.setTimeout(90_000)
  await page.setViewportSize({ width: 1400, height: 900 })
  const blocks = paragraphs(1000, 60)
  blocks[900] = 'The Zanzibar paragraph near the end. ' + blocks[900]
  await paste(page, blocks)
  // A fixed zoom: at fit-spread the scale itself changes with the page height after a trim change,
  // which moves everything on screen once more.
  await page.locator('[data-control-id="pagination.zoom"]').selectOption('100')
  await editor(page).focus()
  await docStart(page)
  await waitForLayout(page)
  await page.keyboard.press('ControlOrMeta+f')
  const panel = page.getByRole('region', { name: 'Find and replace' })
  // Change the trim, and search in the same task: the far match is not redrawn yet.
  await page.evaluate(() => window.__nvE2E.setTrimSize('us-6x9'))
  await panel.getByRole('textbox', { name: 'Find' }).fill('Zanzibar')
  await expect(page.getByTestId('find-status')).toHaveText('1 of 1')
  await waitForLayout(page)
  // The current match is visible in the editor region, at its final place.
  const box = (await page.locator('.nv-find-match-current').first().boundingBox())!
  const main = (await page.getByRole('main', { name: 'Editor' }).boundingBox())!
  expect(box.y).toBeGreaterThanOrEqual(main.y)
  expect(box.y + box.height).toBeLessThanOrEqual(main.y + main.height)
  await page.keyboard.press('Escape')
  // Selection-driven scrolling (PM scrollIntoView) during a reflow: Mod-End right after a trim change.
  await page.evaluate(() => window.__nvE2E.setTrimSize('us-5x8'))
  await docStart(page)
  await waitForLayout(page)
  await page.evaluate(() => window.__nvE2E.setTrimSize('us-6x9'))
  await docEnd(page)
  await waitForLayout(page)
  const caret = await page.evaluate(() => {
    const s = getSelection()!
    const r = document.createRange()
    r.setStart(s.focusNode!, s.focusOffset)
    const rc = r.getClientRects()[0] ?? r.getBoundingClientRect()
    return { top: rc.top, bottom: rc.bottom }
  })
  expect(caret.top).toBeGreaterThanOrEqual(main.y)
  expect(caret.bottom).toBeLessThanOrEqual(main.y + main.height)
})

test('PageDown on the last spread goes to the end of the book, PageUp on the first to its start', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  await paste(page, paragraphs(12))
  const { pageCount } = await layout(page)
  // PageDown spread by spread to the top of the last spread, then once more: the end, not backwards.
  await docStart(page)
  const rows = Math.floor(pageCount / 2) // rows after the first (page 0 sits alone in row 0)
  for (let i = 0; i < rows; i++) await page.keyboard.press('PageDown')
  await expect.poll(async () => (await layout(page)).currentPage).toBe(2 * rows - 1)
  await page.keyboard.press('PageDown')
  const textAfterCaret = () =>
    editor(page).evaluate((el) => {
      const s = getSelection()!
      const r = document.createRange()
      r.selectNodeContents(el)
      r.setStart(s.focusNode!, s.focusOffset)
      return r.toString().length
    })
  await expect.poll(textAfterCaret).toBe(0)
  expect((await layout(page)).currentPage).toBe(pageCount - 1)
  await docStart(page)
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('PageUp')
  await expect.poll(() => page.evaluate(() => getSelection()!.focusOffset)).toBe(0)
  await expect.poll(async () => (await layout(page)).currentPage).toBe(0)
})
