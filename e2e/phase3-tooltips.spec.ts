import { expect, test, type Locator, type Page } from '@playwright/test'
import { buildPaginationFixture } from './fixtures/pagination-manuscript'
import { clickBlockStart, editor, launch, openRecent, reveal, ribbonTab, saveStatus, seedProject, waitForLayout, writeFile, type RibbonTab } from './helpers'

/**
 * Phase 3 acceptance, tooltip coverage: the app-level audit (window.__nvE2E.auditTooltips, i.e.
 * auditTooltipCoverage over the whole page incl. portals) in Book mode with a tracked change, a
 * comment and a re-write in the book, with every Phase 3 menu, dialog and popover open in turn:
 * the in-app menu bar (Windows / web) and its submenus, every ribbon tab, its collapsed groups and
 * More in a narrow window, Settings, the change popover, comment cards (composer, reply, edit), the
 * re-write view (versions, rename, Keep buttons) and the Re-writes list, the page-turn controls and
 * the page indicator's Go to Page. Then hover and keyboard-focus tooltips on the Phase 3 controls.
 * (The macOS native menu bar is exempt: decision 4ec247fc.)
 */

const ctl = (scope: Page | Locator, id: string) => scope.locator(`[data-control-id="${id}"]`)
const tip = (page: Page) => page.locator('[data-tooltip-body]')
const TABS: RibbonTab[] = ['home', 'insert', 'layout', 'review', 'view']

/** Phase 3 controls in the window (ribbon controls on their tab). */
const PHASE3_CONTROLS = [
  'review.track',
  'review.markup',
  'ribbon.cmd.review.change.prev',
  'ribbon.cmd.review.change.next',
  'ribbon.cmd.review.accept',
  'review.accept.options',
  'ribbon.cmd.review.reject',
  'review.reject.options',
  'comment.new',
  'ribbon.cmd.comment.prev',
  'ribbon.cmd.comment.next',
  'ribbon.cmd.comment.showResolved',
  'ribbon.group.review.rewrite',
  'ribbon.cmd.insert.comment',
  'ribbon.cmd.view.bookNavigation',
  'ribbon.cmd.view.scrollNavigation',
  'comment.panel',
  'pagination.previousSpread',
  'pagination.nextSpread',
  'pagination.pageIndicator',
]

async function audit(page: Page, where: string, ids: string[] = []) {
  for (const id of ids) await expect((await reveal(page, id)).first(), `${where}: ${id} rendered`).toBeVisible()
  const problems = await page.evaluate(() => window.__nvE2E.auditTooltips())
  expect(problems, where).toEqual([])
  return page.evaluate(() => window.__nvE2E.countControls())
}

async function escapeFrom(page: Page, layer: Locator) {
  await page.keyboard.press('Escape')
  try {
    await expect(layer).toHaveCount(0, { timeout: 1000 })
  } catch {
    await page.keyboard.press('Escape')
    await expect(layer).toHaveCount(0)
  }
}

async function openBook(page: Page, width = 1400) {
  await page.setViewportSize({ width, height: 900 })
  await launch(page)
  const fx = buildPaginationFixture({ words: 8000, chapters: 3 })
  const content = fx.doc.content as { type: string; content: { type: string; text: string; marks?: unknown[] }[] }[]
  const stamp = { id: 'tt-i', author: 'Ann', date: '2026-11-01T10:00:00.000Z', authorColor: null }
  const first = content[1].content[0]
  const cut = first.text.indexOf(' ')
  // A comment on the first word, and a tracked insertion after it, on the first page.
  content[1] = {
    ...content[1],
    content: [
      { type: 'text', text: first.text.slice(0, cut), marks: [{ type: 'comment', attrs: { id: 'tt-c' } }] },
      { type: 'text', text: ' tracked words', marks: [{ type: 'insertion', attrs: stamp }] },
      { ...first, text: first.text.slice(cut) },
      ...content[1].content.slice(1),
    ],
  }
  await seedProject(page, '/projects/Tips3', 'Tips3', { type: 'doc', content })
  await writeFile(
    page,
    '/projects/Tips3/comments.json',
    JSON.stringify({
      version: 1,
      threads: [{ id: 'tt-c', createdAt: '2026-11-01T10:00:00.000Z', author: 'Test Writer', resolved: false, messages: [{ id: 'm1', author: 'Test Writer', date: '2026-11-01T10:00:00.000Z', text: 'A note.' }] }],
    }),
  )
  await openRecent(page, '/projects/Tips3')
  await expect(saveStatus(page)).toHaveText('Tips3: All changes saved')
  await waitForLayout(page)
  expect(await page.evaluate(() => !!document.querySelector('.nv-desk[data-navigation="book"]'))).toBe(true)
}

test('Phase 3: every control has a wired tooltip, with each menu, dialog and popover open', async ({ page }) => {
  test.setTimeout(180_000)
  await openBook(page)
  // Off the first spread, so Previous pages is enabled too.
  await page.evaluate(() => window.__nvE2E.turnSpread(1))
  await audit(page, 'Book mode', PHASE3_CONTROLS)
  await page.evaluate(() => window.__nvE2E.edgeSpread(-1))

  // Every ribbon tab.
  for (const tab of TABS) {
    await ribbonTab(page, tab)
    await audit(page, `ribbon tab ${tab}`, [`ribbon.tab.${tab}`])
  }

  // The in-app menu bar (Windows / web): every menu and submenu.
  const bar = page.getByRole('menubar', { name: 'Menu bar' })
  await editor(page).click()
  for (const m of ['file', 'edit', 'view', 'insert', 'format', 'review', 'help']) {
    await bar.locator(`[data-control-id="menu.${m}"]`).click()
    const menu = page.getByRole('menu').first()
    await expect(menu).toBeVisible()
    await audit(page, `menu ${m}`)
    for (const sub of await menu.locator('[aria-haspopup="menu"]').all()) {
      await sub.focus()
      await sub.press('ArrowRight')
      await expect(page.getByRole('menu')).toHaveCount(2)
      await audit(page, `a submenu of ${m}`)
      await page.keyboard.press('ArrowLeft')
      await expect(page.getByRole('menu')).toHaveCount(1)
    }
    await escapeFrom(page, page.getByRole('menu'))
  }

  // The ribbon's own dropdowns: Markup, the Accept / Reject split buttons.
  for (const id of ['review.markup', 'review.accept.options', 'review.reject.options']) {
    await (await reveal(page, id)).click()
    await expect(page.getByRole('menu').first()).toBeVisible()
    await audit(page, `ribbon dropdown ${id}`)
    await escapeFrom(page, page.getByRole('menu'))
  }

  // Settings.
  await bar.locator('[data-control-id="menu.file"]').click()
  await page.locator('[role="menu"] [data-control-id="settings.open"]').click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await expect(settings).toBeVisible()
  await audit(page, 'Settings', ['settings.authorName', 'settings.pageNavigation', 'settings.reduceMotion', 'settings.done'])
  await ctl(page, 'settings.done').click()
  await expect(settings).toHaveCount(0)

  // The change popover (a click on the tracked words).
  await clickBlockStart(page, editor(page).locator('.nv-ins').first())
  await expect(page.getByTestId('change-popover')).toBeVisible()
  await audit(page, 'change popover', ['review.popover.accept', 'review.popover.reject'])
  await escapeFrom(page, page.getByTestId('change-popover'))

  // Comment cards: the card, its reply and edit fields, and the composer.
  const card = page.locator('[data-testid="comments-panel"] article[data-thread-id="tt-c"]')
  await expect(card).toBeVisible()
  await audit(page, 'comment card', ['comment.replyStart', 'comment.resolve', 'comment.delete'])
  await ctl(card, 'comment.replyStart').click()
  await audit(page, 'comment reply', ['comment.replyField', 'comment.reply', 'comment.replyCancel'])
  await ctl(card, 'comment.replyCancel').click()
  await ctl(card, 'comment.edit').first().click()
  await audit(page, 'comment edit', ['comment.editField', 'comment.editSave', 'comment.editCancel'])
  await ctl(card, 'comment.editCancel').click()
  await page.evaluate(() => {
    const e = window.__nvE2E
    const at = e.blockPos(2) + 1
    e.selectText(at, at + 3)
  })
  await (await reveal(page, 'comment.new')).click()
  await audit(page, 'comment composer', ['comment.composeField', 'comment.composeSubmit', 'comment.composeCancel'])
  await ctl(page, 'comment.composeCancel').click()

  // The re-write view: versions, rename, the Keep buttons; then the Re-writes list.
  await clickBlockStart(page, editor(page).locator(':scope > p').nth(3))
  await page.keyboard.press('ControlOrMeta+Alt+w')
  const view = page.getByTestId('rewrite-view')
  await expect(view).toBeVisible()
  await page.keyboard.type('Then ')
  await ctl(page, 'rewrite.newVersion').click()
  await audit(page, 're-write view', ['rewrite.newVersion', 'rewrite.keepOriginal', 'rewrite.keepVersion', 'rewrite.discard', 'rewrite.closeButton', 'rewrite.versionTab'])
  await ctl(page, 'rewrite.rename').first().click()
  await audit(page, 're-write rename', ['rewrite.renameField'])
  await page.keyboard.press('Escape')
  for (const tab of TABS) {
    await ribbonTab(page, tab)
    await audit(page, `re-write view, ribbon tab ${tab}`)
  }
  await ctl(page, 'rewrite.closeButton').click()
  await expect(view).toHaveCount(0)
  await page.evaluate(() => window.__nvE2E.runCommand('rewrite.list'))
  const list = page.getByRole('dialog', { name: 'Re-writes' })
  await expect(list).toBeVisible()
  await audit(page, 'Re-writes list', ['rewrite.listClose'])
  await escapeFrom(page, list)

  // The page indicator's Go to Page.
  await ctl(page, 'pagination.pageIndicator').click()
  await expect(ctl(page, 'goToPage.number')).toBeVisible()
  await audit(page, 'Go to Page', ['goToPage.number'])
  await escapeFrom(page, ctl(page, 'goToPage.number'))

  // A narrow window: collapsed ribbon groups and More, on every tab.
  await page.setViewportSize({ width: 600, height: 800 })
  for (const tab of TABS) {
    await ribbonTab(page, tab)
    const row = page.locator(`[data-ribbon-panel="${tab}"]`)
    const triggers = await row.locator('[data-control-id^="ribbon.group."], [data-control-id="ribbon.more"]').evaluateAll((els) =>
      els.filter((e) => (e as HTMLElement).offsetParent !== null).map((e) => e.getAttribute('data-control-id')!),
    )
    await audit(page, `narrow ribbon tab ${tab}`)
    for (const id of triggers) {
      await row.locator(`[data-control-id="${id}"]`).click()
      await expect(page.getByRole('menu').first()).toBeVisible()
      await audit(page, `narrow ${tab}: ${id}`)
      await escapeFrom(page, page.getByRole('menu'))
    }
    if (tab === 'review') expect(triggers.length, 'Review collapses at 600 px').toBeGreaterThan(0)
  }
})

test('Phase 3 controls show their tooltip on hover and on keyboard focus', async ({ page }) => {
  test.setTimeout(120_000)
  // Wide enough that every Review control is on the bar (macOS fonts are wider): focus here means the
  // control itself, not an item of a collapsed group's dropdown (the dropdowns are audited above).
  await openBook(page, 1920)
  await page.evaluate(() => window.__nvE2E.turnSpread(1))
  const ON_BAR = PHASE3_CONTROLS.filter((id) => id !== 'ribbon.group.review.rewrite')
  const away = async () => {
    const box = (await page.getByRole('main', { name: 'Editor' }).boundingBox())!
    await page.mouse.move(box.x + 8, box.y + box.height - 8, { steps: 4 })
  }
  for (const id of ON_BAR) {
    await away()
    await expect(tip(page)).toHaveCount(0)
    await (await reveal(page, id)).first().hover()
    await expect(tip(page), `hover tooltip for ${id}`).toBeVisible()
    await expect(tip(page), `hover tooltip for ${id}`).toHaveText(/\w.{8,}/)
  }
  await away()
  // Keyboard focus: a key press first (keyboard modality), then focus each control. Retried as a whole
  // (macOS: a late focus return from the previous Escape can take the focus back; see phase2-tooltips).
  for (const id of ON_BAR) {
    const control = (await reveal(page, id)).first()
    expect(await control.evaluate((el) => !el.closest('[role="menu"]')), `${id} is on the bar at 1920 px`).toBe(true)
    await expect(async () => {
      await page.keyboard.press('Escape')
      await expect(tip(page)).toHaveCount(0, { timeout: 1000 })
      await editor(page).focus()
      await page.keyboard.press('Shift')
      await control.focus()
      await expect(control).toBeFocused({ timeout: 1000 })
      await expect(tip(page)).toBeVisible({ timeout: 2000 })
    }, `focus tooltip for ${id}`).toPass({ timeout: 15_000 })
  }
  await page.keyboard.press('Escape')
})
