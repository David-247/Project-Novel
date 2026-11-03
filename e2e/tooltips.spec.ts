import { expect, test } from '@playwright/test'

// Shortcut hints render per platform from one spec: "⌘B" on macOS, "Ctrl+B" elsewhere.
const isMac = process.platform === 'darwin'
const mod = (key: string) => (isMac ? `⌘${key}` : `Ctrl+${key}`)

test('hover a toolbar button: tooltip with title, description and shortcut', async ({ page }) => {
  await page.goto('/')
  const bold = page.locator('[data-control-id="toolbar.bold"]')
  await bold.hover()
  const tip = page.locator('[data-tooltip-body]')
  await expect(tip).toBeVisible()
  await expect(tip).toContainText('Bold')
  await expect(tip).toContainText(mod('B'))
  await expect(tip).toContainText('Make the selected text bold')
  // The open tooltip is what the button is described by.
  const describedBy = await bold.getAttribute('aria-describedby')
  await expect(page.locator(`[id="${describedBy}"]`)).toHaveAttribute('role', 'tooltip')

  // Moving to a neighbour switches instantly (skip delay) and the first one goes away.
  // (Real pointer paths: several moves, not one jump, so Radix's hover grace area resolves.)
  const italic = (await page.locator('[data-control-id="toolbar.italic"]').boundingBox())!
  await page.mouse.move(italic.x + italic.width / 2, italic.y + italic.height / 2, { steps: 8 })
  await expect(tip).toHaveCount(1)
  await expect(tip).toContainText('Italic')
  await expect(tip).toContainText(mod('I'))

  // Hover works on disabled controls too (undo is disabled in an empty document).
  const undo = page.locator('[data-control-id="history.undo"]')
  await expect(undo).toBeDisabled()
  await undo.hover()
  await expect(tip).toHaveCount(1)
  await expect(tip).toContainText('Undo')
  await expect(tip).toContainText(mod('Z'))
})

test('keyboard focus shows the tooltip; Escape closes it AND still returns focus to the editor', async ({ page }) => {
  await page.goto('/')
  const editor = page.getByRole('textbox', { name: 'Manuscript' })
  await editor.click()
  await page.keyboard.type('Hello')
  // Shift+Tab from the editor lands in the toolbar (single tab stop, roving focus).
  await page.locator('[data-control-id="toolbar.bold"]').focus()
  const tip = page.locator('[data-tooltip-body]')
  await expect(tip).toContainText('Bold')
  await page.keyboard.press('ArrowRight')
  await expect(page.locator('[data-control-id="toolbar.italic"]')).toBeFocused()
  await expect(tip).toContainText('Italic')

  await page.keyboard.press('Escape')
  await expect(tip).toHaveCount(0)
  await expect(editor).toBeFocused()
})

test('Tab through the find panel: tooltips on fields, buttons and checkboxes; Escape closes tooltip and panel', async ({ page }) => {
  await page.goto('/')
  const editor = page.getByRole('textbox', { name: 'Manuscript' })
  await editor.click()
  await page.keyboard.type('One cat, two cats.')
  await page.keyboard.press('ControlOrMeta+f')
  const panel = page.getByRole('region', { name: 'Find and replace' })
  const find = panel.getByRole('textbox', { name: 'Find' })
  await expect(find).toBeFocused()
  const tip = page.locator('[data-tooltip-body]')
  // Opened by shortcut: no tooltip over the field the user is about to type in.
  await expect(tip).toHaveCount(0)
  await page.keyboard.type('cat')
  await expect(page.getByTestId('find-status')).toHaveText('1 of 2')

  // Tab: previous/next/close buttons, then the replace field.
  await page.keyboard.press('Tab')
  await expect(panel.locator('[data-control-id="find.previous"]')).toBeFocused()
  await expect(tip).toContainText('Previous match')
  await page.keyboard.press('Tab')
  await page.keyboard.press('Tab')
  await expect(panel.locator('[data-control-id="find.close"]')).toBeFocused()
  await expect(tip).toContainText('Close find and replace')
  await expect(tip).toContainText('Esc')
  await page.keyboard.press('Tab')
  await expect(panel.getByRole('textbox', { name: 'Replace with' })).toBeFocused()
  await expect(tip).toContainText('Text that replaces each match')
  // Typing hides it so it never covers the text.
  await page.keyboard.type('dog')
  await expect(tip).toHaveCount(0)

  await panel.getByRole('checkbox', { name: 'Match case' }).focus()
  await page.keyboard.press('Shift+Tab')
  await page.keyboard.press('Tab')
  await expect(tip).toContainText('Only find matches with the same capital letters')
  // Hovering the checkbox label (not just the box) also shows it.
  await page.mouse.move(0, 0)
  await panel.getByText('Whole word', { exact: true }).hover()
  await expect(tip).toContainText('Only find whole words')

  // One Escape: the tooltip closes and the panel's Escape-to-close still runs.
  await page.mouse.move(0, 0)
  await panel.getByRole('checkbox', { name: 'Whole word' }).focus()
  await page.keyboard.press('Shift+Tab')
  await expect(panel.getByRole('checkbox', { name: 'Match case' })).toBeFocused()
  await expect(tip).toContainText('Match case')
  await page.keyboard.press('Escape')
  await expect(tip).toHaveCount(0)
  await expect(panel).toHaveCount(0)
  await expect(editor).toBeFocused()
})
