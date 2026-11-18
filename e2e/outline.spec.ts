import { expect, test, type Page } from '@playwright/test'
import { clickBlockStart, editor, launch, openRecent, projectNavigation, reveal, saveStatus, seedProject, seedProjectNavigation, turnSettled, waitForLayout } from './helpers'

/**
 * Phase 4 navigation pane (View ▸ Navigation Pane, src/features/outline): Word's Headings tree of
 * Front matter, chapters and subheadings with word counts and page ranges. Covers: opening it (ribbon,
 * shortcut), jumping to a chapter by click and by keyboard in this project's navigation mode (the spec
 * runs in Book mode and in Scroll mode: playwright.config.ts BOTH_MODES), live counts after typing, a
 * trim-size change and a markup-view switch, keyboard-only use of the tree, tooltips, the narrow-window
 * overlay, persistence of the open state and width across a restart, and AA contrast on every paper
 * surface in light and dark.
 */

const WORDS = ['night', 'river', 'quiet', 'lantern', 'stone', 'window', 'garden', 'letter', 'morning', 'shadow']
const prose = (n: number, seed: number) => Array.from({ length: n }, (_, i) => WORDS[(i * 7 + seed) % WORDS.length]).join(' ') + '.'
const text = (t: string, marks?: unknown[]) => ({ type: 'text', text: t, ...(marks ? { marks } : {}) })
const p = (t: string) => ({ type: 'paragraph', content: [text(t)] })
const change = { id: 'ch5', author: 'Ann', date: '2026-01-01T00:00:00Z' }

/** Six chapters of ~4 pages each; chapter 3 has two subheadings; chapter 5's title is a tracked insertion. */
function buildBook() {
  const content: unknown[] = [p('For everyone who waited.')]
  const titles = ['Departure', 'The Crossing', 'Harbour Lights', 'Storm', 'Landfall', 'Home']
  titles.forEach((title, c) => {
    if (c === 4) content.push({ type: 'heading', attrs: { level: 1, trackedInsert: change }, content: [text(title, [{ type: 'insertion', attrs: change }])] })
    else content.push({ type: 'heading', attrs: { level: 1 }, content: [text(title)] })
    for (let i = 0; i < 12; i++) {
      if (c === 2 && i === 4) content.push({ type: 'heading', attrs: { level: 2 }, content: [text('Night watch')] })
      if (c === 2 && i === 8) content.push({ type: 'heading', attrs: { level: 2 }, content: [text('Morning')] })
      content.push(p(prose(80, c * 13 + i)))
    }
  })
  return { type: 'doc', content }
}

const pane = (page: Page) => page.getByRole('complementary', { name: 'Navigation' })
const row = (page: Page, key: string) => page.locator(`[role="treeitem"][data-outline-key="${key}"]`)
const counts = (page: Page, key: string) => row(page, key).locator('[data-outline-counts]')
const SHORTCUT = 'ControlOrMeta+Shift+O'
/** The visible tooltip (its title and description; the role="tooltip" node holds the description only). */
const tooltipBody = (page: Page) => page.locator('[data-tooltip-body]')

async function open(page: Page, folder: string) {
  await page.setViewportSize({ width: 1400, height: 900 })
  await launch(page)
  await seedProject(page, folder, folder.split('/').pop()!, buildBook())
  await openRecent(page, folder)
  await expect(saveStatus(page)).toHaveText(`${folder.split('/').pop()}: All changes saved`)
  await waitForLayout(page)
}

/** The document position of top-level block `index`, the caret, and whether page `pageIndex` is in view. */
const blockPos = (page: Page, index: number) => page.evaluate((i) => window.__nvE2E.blockPos(i), index)
const caret = (page: Page) => page.evaluate(() => window.__nvE2E.selection()!.from)
async function pageInView(page: Page, pos: number) {
  return page.evaluate((at) => {
    const l = window.__nvE2E.layout()
    const i = l.pages.findIndex((pg) => !pg.isBlank && pg.from <= at && at < pg.to)
    return { index: i, first: l.visibleSpread.first, last: l.visibleSpread.last, inView: i >= l.visibleSpread.first && i <= l.visibleSpread.last }
  }, pos)
}
/** Top-level block index of chapter `c`'s title (0-based) in buildBook(). */
const titleBlock = (c: number) => 1 + c * 13 + (c > 2 ? 2 : 0)

test.beforeEach(async ({ page }, testInfo) => {
  await seedProjectNavigation(page, testInfo)
})

test('opens from the ribbon and the shortcut; a click and Enter jump to the chapter, its page in view, focus back in the manuscript', async ({ page }, testInfo) => {
  await open(page, '/projects/Outline')
  // Ribbon View ▸ Show ▸ Navigation Pane (a pressed toggle).
  const button = await reveal(page, 'ribbon.cmd.view.navigationPane')
  await expect(button).toHaveAttribute('aria-pressed', 'false')
  await button.click()
  await expect(pane(page)).toBeVisible()
  await expect(button).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('treeitem')).toHaveCount(1 + 6 + 2)
  await expect(row(page, 'ch:0')).toHaveAttribute('aria-label', /^Chapter 1: Departure, [\d,]+ words, pages? \d/)
  // Docked at the left of the pages: the editor region starts at its right edge.
  const pb = (await pane(page).boundingBox())!
  const mb = (await page.getByRole('main', { name: 'Editor' }).boundingBox())!
  expect(pb.x).toBeLessThan(mb.x)
  expect(Math.abs(pb.x + pb.width - mb.x)).toBeLessThanOrEqual(1)

  // Click chapter 4 (Storm): the caret goes to its start, its page is shown, the manuscript has the focus.
  await row(page, 'ch:3').click()
  await turnSettled(page)
  const storm = await blockPos(page, titleBlock(3))
  await expect.poll(() => caret(page)).toBe(storm + 1)
  await expect(editor(page)).toBeFocused()
  await expect.poll(async () => (await pageInView(page, storm + 1)).inView).toBe(true)
  await expect(row(page, 'ch:3')).toHaveAttribute('aria-selected', 'true')
  if (projectNavigation(testInfo) === 'scroll') {
    // Scroll mode: a chapter opening its page shows that page from its top (Word scrolls the heading up).
    const { index } = await pageInView(page, storm + 1)
    await expect.poll(() => page.evaluate(() => window.__nvE2E.layout().visibleSpread.first)).toBeLessThanOrEqual(index)
  }

  // From the keyboard: the shortcut puts the focus on the current heading; End, Enter jumps to the last chapter.
  await page.keyboard.press(SHORTCUT) // closes (it was open)
  await expect(pane(page)).toBeHidden()
  await page.keyboard.press(SHORTCUT)
  await expect(pane(page)).toBeVisible()
  await expect(row(page, 'ch:3')).toBeFocused()
  await page.keyboard.press('End')
  await expect(row(page, 'ch:5')).toBeFocused()
  await page.keyboard.press('Enter')
  await turnSettled(page)
  const home = await blockPos(page, titleBlock(5))
  await expect.poll(() => caret(page)).toBe(home + 1)
  await expect(editor(page)).toBeFocused()
  await expect.poll(async () => (await pageInView(page, home + 1)).inView).toBe(true)
  // Typing goes into the manuscript at the chapter start.
  await page.keyboard.type('X')
  await expect(editor(page).locator('h1').nth(5)).toHaveText('XHome')
})

test('word and page counts follow typing, a trim-size change and a markup-view switch', async ({ page }) => {
  await open(page, '/projects/Live')
  await page.keyboard.press(SHORTCUT)
  await expect(pane(page)).toBeVisible()
  const words = async (key: string) => Number((await counts(page, key).textContent())!.match(/^([\d,]+) words?/)![1].replace(/,/g, ''))
  const pagesOf = async (key: string) => (await counts(page, key).textContent())!.replace(/^.*· /, '')
  const total = () => page.getByTestId('outline-total')
  await expect(counts(page, 'ch:1')).toContainText(/pp?\. \d/)
  const w1 = await words('ch:1')
  const totalBefore = await total().textContent()

  // Typing at the end of a paragraph of chapter 2: its count (and the total) follow.
  await clickBlockStart(page, editor(page).locator('p').nth(1 + 12 + 3))
  await page.keyboard.type('two more ')
  await expect.poll(() => words('ch:1')).toBe(w1 + 2)
  await expect(total()).not.toHaveText(totalBefore!)

  // A smaller trim size: more pages, and the page ranges move.
  const before = await pagesOf('ch:5')
  const pagesBefore = await page.evaluate(() => window.__nvE2E.layout().pageCount)
  await page.evaluate(() => window.__nvE2E.setTrimSize('us-5x8'))
  await expect.poll(() => page.evaluate(() => window.__nvE2E.layout().pageCount)).toBeGreaterThan(pagesBefore)
  await waitForLayout(page)
  await expect.poll(() => pagesOf('ch:5')).not.toBe(before)
  const last = await page.evaluate(() => window.__nvE2E.layout().pageCount)
  await expect(counts(page, 'ch:5')).toContainText(new RegExp(`–${last}$`))
  await expect(total()).toContainText(`${last} pages`)

  // Original (the tracked "Landfall" title not shown): no chapter opens there, the tree follows.
  await expect(row(page, 'ch:4')).toContainText('Landfall')
  const storm = await words('ch:3')
  const landfall = await words('ch:4')
  await page.evaluate(() => window.__nvE2E.setMarkupView('original'))
  await expect(page.getByRole('treeitem')).toHaveCount(1 + 5 + 2)
  await expect(row(page, 'ch:4')).toContainText('Home')
  // Storm now runs on to Home: it counts Landfall's text too (the counts are of the accepted text).
  await expect.poll(() => words('ch:3')).toBe(storm + landfall)
  await page.evaluate(() => window.__nvE2E.setMarkupView('all'))
  await expect(page.getByRole('treeitem')).toHaveCount(1 + 6 + 2)
  await expect(row(page, 'ch:4')).toContainText('Landfall')
})

test('keyboard only: arrows, Left / Right fold a chapter, type-ahead, tooltips on focus, Escape back to the manuscript', async ({ page }) => {
  await open(page, '/projects/Keys')
  await editor(page).click()
  await page.keyboard.press(SHORTCUT)
  await expect(row(page, 'front')).toBeFocused()
  // The focused heading's tooltip shows (keyboard focus).
  await page.keyboard.press('ArrowDown')
  await expect(row(page, 'ch:0')).toBeFocused()
  await expect(tooltipBody(page)).toContainText('Chapter 1: Departure')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await expect(row(page, 'ch:2')).toBeFocused()
  await expect(row(page, 'ch:2')).toHaveAttribute('aria-expanded', 'true')
  await page.keyboard.press('ArrowRight')
  await expect(row(page, 'ch:2/sub:0')).toBeFocused()
  await page.keyboard.press('ArrowLeft')
  await expect(row(page, 'ch:2')).toBeFocused()
  await page.keyboard.press('ArrowLeft')
  await expect(row(page, 'ch:2')).toHaveAttribute('aria-expanded', 'false')
  await expect(row(page, 'ch:2/sub:0')).toHaveCount(0)
  await page.keyboard.press('ArrowRight')
  await expect(row(page, 'ch:2/sub:1')).toBeVisible()
  // Type-ahead: "st" → Storm; "h" → Harbour Lights, then (again) Home.
  await page.keyboard.type('st')
  await expect(row(page, 'ch:3')).toBeFocused()
  await page.waitForTimeout(700)
  await page.keyboard.press('Home')
  await page.keyboard.type('h')
  await expect(row(page, 'ch:2')).toBeFocused()
  await page.keyboard.type('h')
  await expect(row(page, 'ch:5')).toBeFocused()
  // Tab leaves the tree in one step (one row in the tab order).
  expect(await page.locator('[role="treeitem"][tabindex="0"]').count()).toBe(1)
  await page.keyboard.press('Escape')
  await expect(editor(page)).toBeFocused()
  await expect(pane(page)).toBeVisible()
})

test('tooltips on hover; the tooltip audit passes with the pane open; the close button hides it', async ({ page }) => {
  await open(page, '/projects/Tips')
  await page.keyboard.press(SHORTCUT)
  await expect(pane(page)).toBeVisible()
  await row(page, 'ch:1').hover()
  await expect(tooltipBody(page)).toContainText('Chapter 2: The Crossing')
  await expect(page.getByRole('tooltip')).toContainText(/Go to this chapter\. [\d,]+ words, pp?\. \d/)
  await page.locator('[data-control-id="outline.resize"]').hover()
  await expect(tooltipBody(page)).toContainText('Resize navigation pane')
  expect(await page.evaluate(() => window.__nvE2E.auditTooltips())).toEqual([])
  const close = pane(page).getByRole('button', { name: 'Close navigation pane' })
  await close.hover()
  await expect(page.getByRole('tooltip')).toContainText('Hide the navigation pane')
  await close.click()
  await expect(pane(page)).toBeHidden()
})

test('a narrow window: the pane floats over the pages, and a jump closes it', async ({ page }) => {
  await open(page, '/projects/Narrow')
  await page.setViewportSize({ width: 700, height: 800 })
  await page.keyboard.press(SHORTCUT)
  await expect(pane(page)).toHaveAttribute('data-overlay', 'true')
  const pb = (await pane(page).boundingBox())!
  const mb = (await page.getByRole('main', { name: 'Editor' }).boundingBox())!
  // Over the editor region (which keeps the full width), not beside it.
  expect(mb.x).toBeLessThanOrEqual(pb.x + 1)
  expect(mb.width).toBeGreaterThan(690)
  expect(pb.height).toBeGreaterThan(300)
  // Touch-tolerant: every heading row is at least 32 px tall.
  for (const box of await page.getByRole('treeitem').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height))) expect(box).toBeGreaterThanOrEqual(32)
  await row(page, 'ch:2').tap().catch(() => row(page, 'ch:2').click())
  await expect(pane(page)).toBeHidden()
  await expect(editor(page)).toBeFocused()
})

test('the open state and the width are kept across a restart (preferences.json)', async ({ page }) => {
  await open(page, '/projects/Keep')
  await page.keyboard.press(SHORTCUT)
  await expect(row(page, 'front')).toBeFocused()
  const handle = page.getByRole('separator', { name: 'Resize navigation pane' })
  await handle.focus()
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await expect(handle).toHaveAttribute('aria-valuenow', '312')
  // A drag too.
  const hb = (await handle.boundingBox())!
  await page.mouse.move(hb.x + hb.width / 2, hb.y + 200)
  await page.mouse.down()
  await page.mouse.move(hb.x + hb.width / 2 + 40, hb.y + 200, { steps: 4 })
  await page.mouse.up()
  await expect(handle).toHaveAttribute('aria-valuenow', '352')
  await expect.poll(async () => JSON.parse((await page.evaluate(() => window.__nvE2E.preferencesFile())) ?? '{}')).toMatchObject({ navigationPane: true, navigationPaneWidth: 352 })

  await launch(page) // restart
  await expect(pane(page)).toBeVisible()
  expect(Math.round((await pane(page).boundingBox())!.width)).toBe(352)
})

/** WCAG contrast of the pane's text on its own background. */
async function paneContrast(page: Page) {
  return pane(page).evaluate((root) => {
    const parse = (c: string) => {
      const m = c.match(/rgba?\(([^)]+)\)/)
      if (!m) return null
      const v = m[1].split(/[ ,/]+/).filter(Boolean).map(Number)
      return [v[0], v[1], v[2], v[3] ?? 1]
    }
    const lum = (rgb: number[]) => {
      const [r, g, b] = rgb.slice(0, 3).map((x) => {
        const s = x / 255
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
      })
      return 0.2126 * r + 0.7152 * g + 0.0722 * b
    }
    const bgOf = (el: Element): number[] => {
      for (let n: Element | null = el; n; n = n.parentElement) {
        const c = parse(getComputedStyle(n).backgroundColor)
        if (c && c[3] >= 1) return c
      }
      return [255, 255, 255, 1]
    }
    const out: { text: string; ratio: number }[] = []
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement!
      const t = (n.textContent ?? '').trim()
      if (!t || el.closest('[hidden]')) continue
      const fg = parse(getComputedStyle(el).color)!
      const bg = bgOf(el)
      const mix = fg.slice(0, 3).map((v, i) => v * fg[3] + bg[i] * (1 - fg[3]))
      const [a, b] = [lum(mix), lum(bg)].sort((x, y) => y - x)
      out.push({ text: t.slice(0, 30), ratio: +((a + 0.05) / (b + 0.05)).toFixed(2) })
    }
    return out
  })
}

for (const scheme of ['light', 'dark'] as const) {
  test(`AA contrast of the pane on every paper surface (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' })
    await open(page, `/projects/Contrast-${scheme}`)
    await page.keyboard.press(SHORTCUT)
    await expect(pane(page)).toBeVisible()
    // The current heading (highlighted) is sampled too: put the caret in a subheading's section.
    await row(page, 'ch:2/sub:0').click()
    await expect(row(page, 'ch:2/sub:0')).toHaveAttribute('aria-selected', 'true')
    for (const surface of ['book', 'white', 'dark', 'auto']) {
      await page.evaluate((s) => window.__nvE2E.runCommand(`book.surface.${s}`), surface)
      await page.evaluate(() => new Promise((r) => setTimeout(r, 150)))
      const samples = await paneContrast(page)
      expect(samples.length).toBeGreaterThanOrEqual(20)
      for (const s of samples) expect(s.ratio, `${surface}: "${s.text}"`).toBeGreaterThanOrEqual(4.5)
    }
  })
}
