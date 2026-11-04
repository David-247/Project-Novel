import { expect, test, type Page } from '@playwright/test'
import { launch, newProject, openRecent, readFile, saveStatus, seedProject } from './helpers'

const ctl = (page: Page, id: string) => page.locator(`[data-control-id="${id}"]`)
const picker = (page: Page) => ctl(page, 'styles.picker')
/** CSS, not role: an open modal hides the manuscript from the accessibility tree. */
const manuscript = (page: Page) => page.locator('main [contenteditable="true"]')
/** Let the editor take the caret position from a click or a native caret key before the next action. */
const settle = (page: Page) => page.evaluate(() => window.__nvE2E.syncSelection())
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
  await settle(page)
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
  // No direct formatting left inline (the paginated view's left/top page offsets are not formatting).
  await expect(body).not.toHaveAttribute('style', /text-align/)
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
  await settle(page)

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

/** Manage styles > select `basedOn` > New style > name it `name` > close. The new id is custom-1. */
async function createCustomStyle(page: Page, basedOn: string, name: string) {
  await ctl(page, 'styles.manage').click()
  const dialog = page.getByRole('dialog', { name: 'Manage styles' })
  await dialog.locator(`[data-style-row="${basedOn}"]`).click()
  await dialog.locator('[data-control-id="styles.manage.new"]').click()
  await dialog.locator('[data-control-id="styles.manage.renameField"]').fill(name)
  await page.keyboard.press('Enter')
  await expect(dialog.locator('[data-style-row="custom-1"]')).toHaveText(new RegExp(name))
  await dialog.locator('[data-control-id="dialog.close"]').click()
  await expect(dialog).toBeHidden()
}

test('a deleted style brought back by redo renders like Body and shows as missing in the picker', async ({ page }) => {
  await launch(page)
  const ed = manuscript(page)
  await ed.click()
  await page.keyboard.type('First line.')
  await page.keyboard.press('Enter')
  await page.keyboard.type('Dear Mara,')
  const bodyIndent = await ed.locator('p').first().evaluate((el) => getComputedStyle(el).textIndent)
  expect(px(bodyIndent)).toBeGreaterThan(0)
  await createCustomStyle(page, 'block-quote', 'Letter')

  const letter = ed.locator('p').nth(1)
  await letter.click()
  await settle(page)
  await picker(page).selectOption({ label: 'Letter' })
  await expect(letter).toHaveAttribute('data-style', 'custom-1')
  await expect(letter).toHaveCSS('text-indent', '0px')
  await letter.click()
  await settle(page)
  await page.keyboard.press('ControlOrMeta+z')
  await expect(letter).toHaveAttribute('data-style', 'body')

  // Delete the (now unused) style, then redo the application: the id comes back without a rule.
  await ctl(page, 'styles.manage').click()
  const dialog = page.getByRole('dialog', { name: 'Manage styles' })
  await dialog.locator('[data-style-row="custom-1"]').click()
  await dialog.locator('[data-control-id="styles.manage.delete"]').click()
  await dialog.locator('[data-control-id="styles.manage.deleteConfirm"]').click()
  await dialog.locator('[data-control-id="dialog.close"]').click()
  await expect(dialog).toBeHidden()
  await letter.click()
  await settle(page)
  await page.keyboard.press('ControlOrMeta+Shift+z')
  // The document holds custom-1 again (the picker says so), but it renders as Body.
  await expect(picker(page).locator('option:checked')).toHaveText('Body (missing style)')
  await expect(letter).toHaveAttribute('data-style', 'body')
  await expect(letter).toHaveCSS('text-indent', bodyIndent)
})

test('dangling ids render as Body / Chapter Title / Subheading; a style based on nothing gets nothing from Body', async ({ page }) => {
  await launch(page)
  const doc = {
    type: 'doc',
    content: [
      { type: 'heading', attrs: { level: 1, styleId: 'gone' }, content: [{ type: 'text', text: 'Title' }] },
      { type: 'heading', attrs: { level: 3, styleId: 'gone' }, content: [{ type: 'text', text: 'Sub' }] },
      { type: 'paragraph', attrs: { styleId: 'gone' }, content: [{ type: 'text', text: 'Lost style.' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Plain body.' }] },
    ],
  }
  await seedProject(page, '/projects/Dangling', 'Dangling', doc)
  await openRecent(page, '/projects/Dangling')
  const ed = manuscript(page)
  const [title, sub, lost, body] = [0, 1, 2, 3].map((i) => ed.locator(':scope > *').nth(i))
  await expect(title).toHaveAttribute('data-style', 'chapter-title')
  await expect(title).toHaveAttribute('data-break-before', 'page')
  await expect(title).toHaveCSS('text-align', 'center')
  await expect(sub).toHaveAttribute('data-style', 'subheading')
  await expect(sub).toHaveCSS('font-weight', '600')
  await expect(lost).toHaveAttribute('data-style', 'body')
  const bodyIndent = await body.evaluate((el) => getComputedStyle(el).textIndent)
  expect(px(bodyIndent)).toBeGreaterThan(0)
  await expect(lost).toHaveCSS('text-indent', bodyIndent)

  // A custom style based on nothing: none of Body's settings (no first-line indent).
  await body.click()
  await settle(page)
  await createCustomStyle(page, 'body', 'Plain')
  await picker(page).selectOption({ label: 'Plain' })
  await expect(body).toHaveAttribute('data-style', 'custom-1')
  await ctl(page, 'styles.edit').click()
  const modify = page.getByRole('dialog', { name: 'Modify style: Plain' })
  await modify.locator('[data-control-id="styles.field.basedOn"]').selectOption('')
  await modify.locator('[data-control-id="styles.modify.save"]').click()
  await expect(modify).toBeHidden()
  await expect(body).toHaveCSS('text-indent', '0px')
  const sheet = await page.getByTestId('book-styles').evaluate((el) => el.textContent ?? '')
  expect(sheet).toContain('[data-style="custom-1"] {  }')
})

test('custom styles and a modified Chapter Title persist through save, close and reopen (book.json)', async ({ page }) => {
  await launch(page)
  await newProject(page, '/projects/Styled')
  const ed = manuscript(page)
  await ed.click()
  await page.keyboard.type('Chapter One')
  await page.keyboard.press('ControlOrMeta+Alt+1')
  await page.keyboard.press('Enter')
  await page.keyboard.type('Dear Mara,')

  // Modify Chapter Title.
  await ed.locator('h1').click()
  await settle(page)
  await ctl(page, 'styles.edit').click()
  const modify = page.getByRole('dialog', { name: 'Modify style: Chapter Title' })
  await modify.locator('[data-control-id="styles.field.fontSize"]').fill('28')
  await modify.locator('[data-control-id="styles.modify.save"]').click()
  await expect(modify).toBeHidden()

  // A custom style, applied to the paragraph.
  await createCustomStyle(page, 'epigraph', 'Letter')
  await ed.locator('p').click()
  await settle(page)
  // (Enter after the Chapter Title made it a First Paragraph.)
  await expect(picker(page)).toHaveValue('first-paragraph')
  await picker(page).selectOption({ label: 'Letter' })
  await expect(ed.locator('p')).toHaveAttribute('data-style', 'custom-1')
  await expect(saveStatus(page)).toHaveText('Styled: Unsaved changes')
  const titleSize = await ed.locator('h1').evaluate((el) => getComputedStyle(el).fontSize)

  await ed.locator('p').click()
  await page.keyboard.press('ControlOrMeta+s')
  await expect(saveStatus(page)).toHaveText('Styled: Saved')
  const book = JSON.parse((await readFile(page, '/projects/Styled/book.json'))!)
  expect(book.styles).toEqual({
    'chapter-title': { fontSize: 28 },
    'custom-1': { name: 'Letter', kind: 'paragraph', basedOn: 'epigraph', builtIn: false },
  })

  // Close and reopen (relaunch: fresh app state, same disk).
  await page.reload()
  await launch(page)
  await openRecent(page, '/projects/Styled')
  await expect(saveStatus(page)).toContainText('Styled:')
  await expect(ed.locator('p[data-style="custom-1"]')).toHaveText('Dear Mara,')
  await expect(ed.locator('p')).toHaveCSS('font-style', 'italic')
  await expect(ed.locator('h1[data-style="chapter-title"]')).toHaveCSS('font-size', titleSize)
  await ed.locator('p').click()
  await expect(picker(page).locator('option:checked')).toHaveText('Letter')
})
