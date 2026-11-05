import { expect, test, type Page } from '@playwright/test'
import { buildPaginationFixture } from './fixtures/pagination-manuscript'
import { docStart, editor, launch, lineEnd, openRecent, pressTab, saveStatus, seedProject, waitForLayout } from './helpers'

/**
 * Phase 3 acceptance, keyboard only: every revision tool used without a pointer, in Book mode. The
 * project is opened through the test backend; from then on only keys: the menu bar (F10), the ribbon
 * (its roving focus), shortcuts, Tab / Shift+Tab, Enter, Escape.
 */

const focusedId = (page: Page) => page.evaluate(() => document.activeElement?.closest('[data-control-id]')?.getAttribute('data-control-id') ?? null)
const count = (page: Page) => page.evaluate(() => window.__nvE2E.countChanges())
const cards = (page: Page) => page.locator('[data-testid="comments-panel"] article[data-thread-id]:not([data-thread-id="draft"])')
const rw = (page: Page) => page.evaluate(() => window.__nvE2E.rewrite())
const view = (page: Page) => page.getByTestId('rewrite-view')

/** Press `key` until the focus is on `target` (each press waits for the focus to move on). */
async function keyTo(page: Page, key: string, target: string, max = 60) {
  for (let i = 0; i < max; i++) {
    const before = await focusedId(page)
    if (before === target) return
    await page.keyboard.press(key)
    await expect.poll(() => focusedId(page), `${key} moves the focus on from ${before}`).not.toBe(before)
  }
  expect(await focusedId(page), `${target} reached with ${key}`).toBe(target)
}

/** The in-app menu bar by keyboard: F10, arrows to the menu, down to the item, Enter. */
async function menuKeys(page: Page, menu: string, item: string, submenu?: string) {
  await page.keyboard.press('F10')
  await expect.poll(() => focusedId(page)).toMatch(/^menu\./)
  await keyTo(page, 'ArrowRight', `menu.${menu}`, 8)
  await page.keyboard.press('ArrowDown')
  await expect(page.getByRole('menu').first()).toBeVisible()
  await expect.poll(() => focusedId(page)).not.toBe(`menu.${menu}`)
  const walk = (target: string) => keyTo(page, 'ArrowDown', target)
  if (submenu) {
    await walk(submenu)
    await page.keyboard.press('ArrowRight')
    await expect(page.getByRole('menu')).toHaveCount(2)
  }
  await walk(item)
  await page.keyboard.press('Enter')
  await expect(page.getByRole('menu')).toHaveCount(0)
}

/** Tab (or Shift+Tab) until the control `id` has the focus. */
async function tabTo(page: Page, id: string, opts: { shift?: boolean; max?: number } = {}) {
  for (let i = 0; i < (opts.max ?? 60) && (await focusedId(page)) !== id; i++) await pressTab(page, opts)
  expect(await focusedId(page), `${id} reached with ${opts.shift ? 'Shift+' : ''}Tab`).toBe(id)
}

test('keyboard only: track changes, comments, re-write, settings, page turns and Go to Page', async ({ page }) => {
  test.setTimeout(180_000)
  await page.setViewportSize({ width: 1400, height: 900 })
  await launch(page)
  const fx = buildPaginationFixture({ words: 8000, chapters: 3 })
  await seedProject(page, '/projects/Keys3', 'Keys3', fx.doc)
  await openRecent(page, '/projects/Keys3')
  await expect(saveStatus(page)).toHaveText('Keys3: All changes saved')
  await waitForLayout(page)
  await editor(page).focus()

  // ---- Track changes: Mod-Shift-e, type, Next Change, the popover (Alt+Enter, Enter), Reject Next, Accept All.
  await page.keyboard.press('ControlOrMeta+Shift+E')
  await expect(page.locator('[data-control-id="review.track"]')).toHaveAttribute('aria-pressed', 'true')
  await docStart(page)
  await page.keyboard.press('ArrowDown')
  await lineEnd(page)
  await page.keyboard.type(' typed with the keys')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Backspace')
  await page.keyboard.press('Backspace')
  expect(await count(page)).toBe(2)
  await docStart(page)
  await page.keyboard.press('ControlOrMeta+Alt+ArrowDown')
  await page.keyboard.press('Alt+Enter')
  await expect(page.getByTestId('change-popover')).toBeVisible()
  await expect(page.locator('[data-control-id="review.popover.accept"]')).toBeFocused()
  await page.keyboard.press('Enter')
  await expect.poll(() => count(page)).toBe(1)
  await expect(editor(page)).toBeFocused()
  await docStart(page)
  await page.keyboard.press('ControlOrMeta+Alt+ArrowDown')
  await page.keyboard.press('ControlOrMeta+Alt+r') // Reject Change and move to the next
  await expect.poll(() => count(page)).toBe(0)
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(() => count(page)).toBe(1)
  await docStart(page)
  await page.keyboard.press('ControlOrMeta+Alt+ArrowDown')
  await page.keyboard.press('ControlOrMeta+Alt+a') // Accept Change and move to the next
  await expect.poll(() => count(page)).toBe(0)
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(() => count(page)).toBe(1)
  await menuKeys(page, 'review', 'review.acceptAll')
  await expect.poll(() => count(page)).toBe(0)
  await editor(page).focus()
  await page.keyboard.press('ControlOrMeta+Shift+E')
  await expect(page.locator('[data-control-id="review.track"]')).toHaveAttribute('aria-pressed', 'false')

  // ---- Comments: select a word, Mod-Alt-m, Mod-Enter; then Tab to the card, reply and resolve.
  await docStart(page)
  await page.keyboard.press('ArrowDown')
  for (let k = 0; k < 4; k++) await page.keyboard.press('Shift+ArrowRight')
  await page.keyboard.press('ControlOrMeta+Alt+m')
  await expect(page.locator('[data-control-id="comment.composeField"]')).toBeFocused()
  await page.keyboard.type('From the keyboard.')
  await page.keyboard.press('ControlOrMeta+Enter')
  await expect(cards(page)).toHaveCount(1)
  await expect(editor(page)).toBeFocused()
  // Review > Next Comment (menu bar by keys) from the start of the book: the caret goes to its anchor.
  await docStart(page)
  await menuKeys(page, 'review', 'comment.next')
  const threadId = (await page.evaluate(() => window.__nvE2E.comments())).threads[0].id
  await expect.poll(async () => (await page.evaluate(() => window.__nvE2E.comments())).activeId).toBe(threadId) // the caret is in its anchor
  await expect(editor(page)).toBeFocused()
  // The panel follows the pages in the Tab order.
  await tabTo(page, 'comment.replyStart')
  await page.keyboard.press('Enter')
  await expect(page.locator('[data-control-id="comment.replyField"]')).toBeFocused()
  await page.keyboard.type('A keyboard reply.')
  await page.keyboard.press('ControlOrMeta+Enter')
  await expect(cards(page).locator('[data-testid="comment-text"]')).toHaveText(['From the keyboard.', 'A keyboard reply.'])
  await tabTo(page, 'comment.resolve')
  await page.keyboard.press('Enter')
  await expect(cards(page)).toHaveCount(0)
  expect((await page.evaluate(() => window.__nvE2E.comments())).threads[0]).toMatchObject({ resolved: true })
  await menuKeys(page, 'review', 'comment.showResolved')
  await expect(cards(page)).toHaveCount(1)

  // ---- Re-write: Mod-Alt-w, type, a second version (menu), switch versions, Keep This Version (Tab, Enter), undo.
  await editor(page).focus()
  await docStart(page)
  for (let k = 0; k < 3; k++) await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ControlOrMeta+Alt+w')
  await expect(view(page)).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Revised passage' })).toBeFocused()
  await page.keyboard.type('Keys: ')
  await menuKeys(page, 'review', 'rewrite.newVersion')
  await expect.poll(async () => (await rw(page)).rewrites[0].versions.length).toBe(2)
  await expect(page.getByRole('textbox', { name: 'Revised passage' })).toBeFocused()
  await page.keyboard.type('Second: ')
  // The version tabs: arrow keys move between them.
  await tabTo(page, 'rewrite.versionTab', { shift: true })
  await page.keyboard.press('ArrowLeft')
  await expect(view(page).getByRole('tab', { name: 'Version 1' })).toHaveAttribute('aria-selected', 'true')
  await tabTo(page, 'rewrite.keepVersion')
  await page.keyboard.press('Enter')
  await expect(view(page)).toHaveCount(0)
  await expect(editor(page)).toBeFocused()
  expect((await rw(page)).rewrites[0].status).toBe('resolved')
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(async () => (await rw(page)).rewrites[0].status).toBe('open')
  expect((await rw(page)).rewrites[0].versions).toHaveLength(2)
  await page.keyboard.press('ControlOrMeta+Shift+z')
  await expect.poll(async () => (await rw(page)).rewrites[0].status).toBe('resolved')
  // Keep Original, by keys, on another paragraph.
  for (let k = 0; k < 3; k++) await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ControlOrMeta+Alt+w')
  await expect(page.getByRole('textbox', { name: 'Revised passage' })).toBeFocused()
  await page.keyboard.type('Not this: ')
  await tabTo(page, 'rewrite.keepOriginal', { shift: true }) // under the original, the left page: before the revision
  await page.keyboard.press('Enter')
  await expect(view(page)).toHaveCount(0)
  await expect.poll(async () => (await rw(page)).rewrites.map((r) => [r.status, r.choice === 'original'])).toEqual([
    ['resolved', false],
    ['resolved', true],
  ])
  // Discard, by keys, on a third: the re-write is gone (its notice offers Undo).
  await expect(editor(page)).toBeFocused()
  for (let k = 0; k < 3; k++) await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ControlOrMeta+Alt+w')
  await expect(page.getByRole('textbox', { name: 'Revised passage' })).toBeFocused()
  await page.keyboard.type('Gone: ')
  await expect.poll(async () => (await rw(page)).rewrites.length).toBe(3)
  await tabTo(page, 'rewrite.discard', { shift: true }) // in the view's header bar
  await page.keyboard.press('Enter')
  await expect(view(page)).toHaveCount(0)
  await expect(page.getByTestId('rewrite-notice')).toContainText('Re-write discarded')
  await expect.poll(async () => (await rw(page)).rewrites.length).toBe(2)

  // ---- Settings: File > Settings…, Page navigation by keyboard, Done.
  await menuKeys(page, 'file', 'settings.open')
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await expect(settings).toBeVisible()
  await tabTo(page, 'settings.pageNavigation')
  // A closed select by type-ahead: "S" picks Scroll through the pages, "T" Turn pages like a book.
  const nav = page.locator('[data-control-id="settings.pageNavigation"]')
  await page.keyboard.press('s')
  await expect(nav).toHaveValue('scroll')
  await expect.poll(() => page.evaluate(() => window.__nvE2E.pageNavigation())).toBe('scroll')
  await expect(page.locator('.nv-desk[data-navigation="scroll"]')).toBeAttached()
  // A select's type-ahead joins keys typed within about a second ("st" matches nothing): let it reset.
  await page.waitForTimeout(1200)
  await expect(nav).toBeFocused()
  await page.keyboard.press('t')
  await expect(nav).toHaveValue('book')
  await expect.poll(() => page.evaluate(() => window.__nvE2E.pageNavigation())).toBe('book')
  await tabTo(page, 'settings.done')
  await page.keyboard.press('Enter')
  await expect(settings).toHaveCount(0)

  // ---- Page turns: PageDown / PageUp, the View menu's spread commands, Go to Page (Mod-Alt-g).
  await editor(page).focus()
  await docStart(page)
  const indicator = page.getByTestId('page-indicator')
  const first = await indicator.textContent()
  await page.keyboard.press('PageDown')
  await expect(indicator).not.toHaveText(first!)
  await page.keyboard.press('PageUp')
  await expect(indicator).toHaveText(first!)
  await menuKeys(page, 'view', 'pagination.nextSpread')
  await expect(indicator).not.toHaveText(first!)
  await menuKeys(page, 'view', 'view.firstSpread')
  await expect(indicator).toHaveText(first!)
  await editor(page).focus()
  await page.keyboard.press('ControlOrMeta+Alt+g')
  await expect(page.locator('[data-control-id="goToPage.number"]')).toBeFocused()
  await page.keyboard.type('5')
  await page.keyboard.press('Enter')
  await expect.poll(async () => (await page.evaluate(() => window.__nvE2E.layout())).currentPage).toBe(4)

  // ---- The ribbon: its roving focus from the tab list into the Review tab's controls; Enter toggles recording.
  // From the manuscript, Shift+Tab goes back to the ribbon (the Formatting toolbar: one Tab stop, roving
  // focus inside it); Home goes to its start, the arrows to the tabs.
  await expect(editor(page)).toBeFocused()
  const inRibbon = () => page.evaluate(() => !!document.activeElement?.closest('[role="toolbar"][aria-label="Formatting"]'))
  for (let i = 0; i < 6 && !(await inRibbon()); i++) {
    const before = await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 200) ?? '')
    await pressTab(page, { shift: true })
    await expect.poll(() => page.evaluate(() => document.activeElement?.outerHTML.slice(0, 200) ?? '')).not.toBe(before)
  }
  expect(await inRibbon(), 'the ribbon reached with Shift+Tab from the manuscript').toBe(true)
  await page.keyboard.press('Home')
  await keyTo(page, 'ArrowRight', 'ribbon.tab.home', 6)
  await keyTo(page, 'ArrowRight', 'ribbon.tab.review', 6)
  await page.keyboard.press('Enter')
  await expect(page.locator('[data-control-id="ribbon.tab.review"]')).toHaveAttribute('aria-selected', 'true')
  for (const id of ['review.track', 'review.markup', 'review.accept.options', 'comment.new', 'ribbon.group.review.rewrite']) await keyTo(page, 'ArrowRight', id, 20)
  await keyTo(page, 'ArrowLeft', 'review.track', 20)
  await page.keyboard.press('Enter')
  await expect(page.locator('[data-control-id="review.track"]')).toHaveAttribute('aria-pressed', 'true')
  // The Re-write group (collapsed into a menu button at this width): opened with Enter, its items by arrows.
  await keyTo(page, 'ArrowRight', 'ribbon.group.review.rewrite', 20)
  await page.keyboard.press('Enter')
  await expect(page.getByRole('menu')).toBeVisible()
  await page.keyboard.press('ArrowDown')
  await expect.poll(() => focusedId(page)).toMatch(/^(ribbon\.cmd\.)?rewrite\./)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toHaveCount(0)
})
