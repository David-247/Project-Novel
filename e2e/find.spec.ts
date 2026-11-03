import { expect, test } from '@playwright/test'

test('find & replace: count + highlights, options, replace all, single undo, redo', async ({ page }) => {
  await page.goto('/')
  const editor = page.getByRole('textbox', { name: 'Manuscript' })
  const toolbar = page.getByRole('toolbar', { name: 'Formatting' })
  const undo = toolbar.locator('[data-control-id="history.undo"]')
  const redo = toolbar.locator('[data-control-id="history.redo"]')
  await expect(undo).toBeDisabled()

  await editor.click()
  await page.keyboard.type('The Cat sat. A cat ran; the category of cats hid.')
  const original = 'The Cat sat. A cat ran; the category of cats hid.'
  await expect(editor).toHaveText(original)
  await expect(undo).toBeEnabled()

  // Mod-f opens the panel with focus in the find field.
  await page.keyboard.press('ControlOrMeta+f')
  const panel = page.getByRole('region', { name: 'Find and replace' })
  const find = panel.getByRole('textbox', { name: 'Find' })
  await expect(find).toBeFocused()
  await expect(toolbar.locator('[data-control-id="find.open"]')).toHaveAttribute('aria-expanded', 'true')

  const status = page.getByTestId('find-status')
  await find.fill('cat')
  await expect(status).toHaveText('1 of 4')
  await expect(editor.locator('.nv-find-match')).toHaveCount(4)
  await expect(editor.locator('.nv-find-match-current')).toHaveCount(1)

  // Enter / Shift+Enter navigate.
  await find.press('Enter')
  await expect(status).toHaveText('2 of 4')
  await find.press('Shift+Enter')
  await expect(status).toHaveText('1 of 4')

  // Options.
  await panel.getByRole('checkbox', { name: 'Whole word' }).check()
  await expect(status).toHaveText(/of 2$/)
  await panel.getByRole('checkbox', { name: 'Match case' }).check()
  await expect(status).toHaveText('1 of 1')
  await expect(editor.locator('.nv-find-match')).toHaveCount(1)

  // Replace all with whole word only: "Cat" and "cat", not "category" / "cats".
  await panel.getByRole('checkbox', { name: 'Match case' }).uncheck()
  await expect(status).toHaveText(/of 2$/)
  await panel.getByRole('textbox', { name: 'Replace with' }).fill('dog')
  // Keyboard activation: the button becomes disabled, focus must stay in the panel.
  await panel.getByRole('button', { name: 'Replace all' }).focus()
  await page.keyboard.press('Enter')
  await expect(find).toBeFocused()
  await expect(status).toHaveText('Replaced 2')
  const replaced = 'The dog sat. A dog ran; the category of cats hid.'
  await expect(editor).toHaveText(replaced)

  // A single undo restores everything; Ctrl+Y redoes it.
  await editor.click()
  await expect(redo).toBeDisabled()
  await page.keyboard.press('ControlOrMeta+z')
  await expect(editor).toHaveText(original)
  await expect(redo).toBeEnabled()
  await page.keyboard.press('ControlOrMeta+y')
  await expect(editor).toHaveText(replaced)
  await page.keyboard.press('ControlOrMeta+z')
  await expect(editor).toHaveText(original)
  await page.keyboard.press('ControlOrMeta+Shift+z')
  await expect(editor).toHaveText(replaced)

  // Escape closes the panel and returns focus to the editor; highlights are removed.
  await find.focus()
  await find.press('Escape')
  await expect(panel).toHaveCount(0)
  await expect(editor).toBeFocused()
  await expect(editor.locator('.nv-find-match')).toHaveCount(0)
})

test('find panel stays below the toolbar and fits a narrow window', async ({ page }) => {
  await page.setViewportSize({ width: 380, height: 700 })
  await page.goto('/')
  await page.getByRole('textbox', { name: 'Manuscript' }).click()
  await page.keyboard.press('ControlOrMeta+f')
  const panel = page.getByRole('region', { name: 'Find and replace' })
  await expect(panel).toBeVisible()
  const header = await page.getByRole('banner', { name: 'Toolbar' }).boundingBox()
  const box = await panel.boundingBox()
  expect(box && header && box.y >= header.y + header.height).toBe(true)
  expect(box && box.x >= 0 && box.x + box.width <= 380).toBe(true)
})

test('the open find panel does not cover the first line of text', async ({ page }) => {
  for (const width of [1200, 380]) {
    await page.setViewportSize({ width, height: 700 })
    await page.goto('/')
    const editor = page.getByRole('textbox', { name: 'Manuscript' })
    await editor.click()
    await page.keyboard.type('The cat sat on the mat with another cat beside the window.')
    await page.keyboard.press('ControlOrMeta+f')
    const panel = page.getByRole('region', { name: 'Find and replace' })
    await expect(panel).toBeVisible()
    // At the top of the document (the editor region may have scrolled to keep the caret visible).
    await page.getByRole('main', { name: 'Editor' }).evaluate((m) => m.scrollTo(0, 0))
    await expect
      .poll(async () => {
        const p = await panel.boundingBox()
        const line = await editor.locator('p').first().boundingBox()
        return !!p && !!line && line.y >= p.y + p.height
      })
      .toBe(true)
    await page.keyboard.press('Escape')
    await expect(panel).toHaveCount(0)
  }
})
