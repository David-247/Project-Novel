import { expect, test, type Page } from '@playwright/test'
import { launch } from './helpers'

const ctl = (page: Page, id: string) => page.locator(`[data-control-id="${id}"]`)
const picker = (page: Page) => ctl(page, 'styles.picker')
/** CSS, not role: an open modal hides the manuscript from the accessibility tree. */
const manuscript = (page: Page) => page.locator('main [contenteditable="true"]')
const px = (v: string) => parseFloat(v)

test('style picker, shortcuts, Enter chaining, undo and Clear direct formatting', async ({ page }) => {
  await launch(page)
  const ed = manuscript(page)
  await ed.click()
  await page.keyboard.type('Chapter One')
  await expect(picker(page)).toHaveValue('body')

  await picker(page).selectOption('chapter-title')
  const title = ed.locator('h1[data-style="chapter-title"]')
  await expect(title).toHaveText('Chapter One')
  // Pagination contract: the block exposes its style's break.
  await expect(title).toHaveAttribute('data-break-before', 'page')
  await expect(picker(page)).toHaveValue('chapter-title')

  // Enter chaining: Chapter Title -> First Paragraph -> Body.
  // Back to the text (the picker keeps focus after a choice, like the other toolbar selects).
  await title.click()
  await expect(ed).toBeFocused()
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await page.keyboard.type('It began at the harbor.')
  await expect(picker(page)).toHaveValue('first-paragraph')
  await page.keyboard.press('Enter')
  await page.keyboard.type('Then the lights came on.')
  await expect(picker(page)).toHaveValue('body')
  const first = ed.locator('p[data-style="first-paragraph"]')
  const body = ed.locator('p[data-style="body"]')
  await expect(first).toHaveCSS('text-indent', '0px')
  expect(px(await body.evaluate((el) => getComputedStyle(el).textIndent))).toBeGreaterThan(0)

  // Shortcut + undo: applying a style is one undo step.
  await page.keyboard.press('ControlOrMeta+Alt+1')
  await expect(ed.locator('h1')).toHaveCount(2)
  await page.keyboard.press('ControlOrMeta+z')
  await expect(ed.locator('h1')).toHaveCount(1)
  await expect(body).toHaveText('Then the lights came on.')
  await page.keyboard.press('ControlOrMeta+Alt+1')
  await page.keyboard.press('ControlOrMeta+Alt+0')
  await expect(ed.locator('h1')).toHaveCount(1)

  // Direct formatting wins over the style; Clear direct formatting restores the style.
  await page.keyboard.press('ControlOrMeta+Shift+e')
  await expect(body).toHaveCSS('text-align', 'center')
  await ctl(page, 'styles.clearFormatting').click()
  await expect(body).not.toHaveAttribute('style', /.+/)
  expect(await body.evaluate((el) => getComputedStyle(el).textAlign)).toMatch(/^(left|start)$/)
})

test('Modify style dialog: live preview, and the change restyles every chapter without a document change', async ({ page }) => {
  await launch(page)
  const ed = manuscript(page)
  await ed.click()
  for (const [i, t] of ['One', 'Two', 'Three'].entries()) {
    if (i) await page.keyboard.press('Enter')
    await page.keyboard.type(`Chapter ${t}`)
    await page.keyboard.press('ControlOrMeta+Alt+1')
    await page.keyboard.press('Enter')
    await page.keyboard.type('Some text.')
  }
  const titles = ed.locator('h1[data-style="chapter-title"]')
  await expect(titles).toHaveCount(3)
  const sizeBefore = px(await titles.first().evaluate((el) => getComputedStyle(el).fontSize))
  await titles.nth(1).click()

  await ctl(page, 'styles.edit').click()
  const dialog = page.getByRole('dialog', { name: 'Modify style: Chapter Title' })
  await expect(dialog).toBeVisible()
  // The preview uses the writer's own words.
  const sample = dialog.getByTestId('style-proof-sample')
  await expect(sample).toHaveText('Chapter Two')
  const previewBefore = px(await sample.evaluate((el) => getComputedStyle(el).fontSize))
  await dialog.locator('[data-control-id="styles.field.fontSize"]').fill('28')
  await expect.poll(async () => px(await sample.evaluate((el) => getComputedStyle(el).fontSize))).toBeCloseTo((previewBefore * 28) / 20, 0)
  await dialog.locator('[data-control-id="styles.field.breakBefore"]').selectOption('recto')
  await expect(dialog.getByTestId('style-proof').getByText('New right-hand page')).toBeVisible()
  expect(await page.evaluate(() => window.__nvE2E.auditTooltips())).toEqual([])

  const version = await page.evaluate(() => window.__nvE2E.docVersion())
  await dialog.locator('[data-control-id="styles.modify.save"]').click()
  await expect(dialog).toBeHidden()
  for (let i = 0; i < 3; i++) {
    await expect.poll(async () => px(await titles.nth(i).evaluate((el) => getComputedStyle(el).fontSize))).toBeCloseTo((sizeBefore * 28) / 20, 0)
    await expect(titles.nth(i)).toHaveAttribute('data-break-before', 'recto')
  }
  expect(await page.evaluate(() => window.__nvE2E.docVersion())).toBe(version)
  expect(await page.evaluate(() => window.__nvE2E.bookStyles())).toEqual({ 'chapter-title': { fontSize: 28, breakBefore: 'recto' } })
})

test('Manage styles: create, rename, apply and delete a custom style (with confirmation)', async ({ page }) => {
  await launch(page)
  const ed = manuscript(page)
  await ed.click()
  await page.keyboard.type('Dear Mara,')

  await ctl(page, 'styles.manage').click()
  const dialog = page.getByRole('dialog', { name: 'Manage styles' })
  await dialog.locator('[data-style-row="block-quote"]').click()
  await dialog.locator('[data-control-id="styles.manage.new"]').click()
  const nameField = dialog.locator('[data-control-id="styles.manage.renameField"]')
  await expect(nameField).toBeFocused()
  await nameField.fill('Letter')
  await page.keyboard.press('Enter')
  await expect(dialog.locator('[data-style-row="custom-1"]')).toHaveText(/Letter/)
  expect(await page.evaluate(() => window.__nvE2E.bookStyles())).toEqual({
    'custom-1': { name: 'Letter', kind: 'paragraph', basedOn: 'block-quote', builtIn: false },
  })
  expect(await page.evaluate(() => window.__nvE2E.auditTooltips())).toEqual([])
  // (Escape would first close a keyboard-focus tooltip inside the dialog, by design; use Close.)
  await dialog.locator('[data-control-id="dialog.close"]').click()
  await expect(dialog).toBeHidden()

  await picker(page).selectOption({ label: 'Letter' })
  await expect(ed.locator('p[data-style="custom-1"]')).toHaveText('Dear Mara,')

  await ctl(page, 'styles.manage').click()
  // Opens on the current paragraph's style.
  await expect(dialog.locator('[data-style-row="custom-1"]')).toHaveAttribute('aria-pressed', 'true')
  await dialog.locator('[data-control-id="styles.manage.delete"]').click()
  await expect(dialog.getByRole('alert')).toContainText('1 paragraph uses it and will switch to Block Quote.')
  await dialog.locator('[data-control-id="styles.manage.deleteConfirm"]').click()
  await expect(dialog.locator('[data-style-row="custom-1"]')).toHaveCount(0)
  await expect(ed.locator('p[data-style="block-quote"]')).toHaveText('Dear Mara,')
  expect(await page.evaluate(() => window.__nvE2E.bookStyles())).toEqual({})
})
