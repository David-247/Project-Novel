import { expect, test } from '@playwright/test'
import { lineStart } from './helpers'

test('formatting toolbar: shortcuts, active state and roving keyboard focus', async ({ page }) => {
  await page.goto('/')
  const editor = page.getByRole('textbox', { name: 'Manuscript' })
  const toolbar = page.getByRole('toolbar', { name: 'Formatting' })
  const bold = toolbar.locator('[data-control-id="toolbar.bold"]')

  await editor.click()
  await page.keyboard.type('Hello ')
  await page.keyboard.press('ControlOrMeta+b')
  await page.keyboard.type('bold')
  await expect(editor.locator('strong')).toHaveText('bold')
  await expect(bold).toHaveAttribute('aria-pressed', 'true')
  await lineStart(page)
  await expect(bold).toHaveAttribute('aria-pressed', 'false')

  await page.keyboard.press('ControlOrMeta+e')
  await expect(editor.locator('p').first()).toHaveCSS('text-align', 'center')
  await expect(toolbar.locator('[data-control-id="toolbar.alignCenter"]')).toHaveAttribute('aria-pressed', 'true')
  // Align right shares its combo with hard reload; the reload guard (on in e2e builds) must let the
  // editor handle it, and the page must not reload (the text is still there).
  await page.keyboard.press('ControlOrMeta+Shift+r')
  await expect(editor.locator('p').first()).toHaveCSS('text-align', 'right')
  await expect(toolbar.locator('[data-control-id="toolbar.alignRight"]')).toHaveAttribute('aria-pressed', 'true')
  await expect(editor).toContainText('Hello bold')
  await page.keyboard.press('ControlOrMeta+e')
  await expect(editor.locator('p').first()).toHaveCSS('text-align', 'center')

  // Keyboard: focus a control, arrows move within the toolbar, Enter activates, Escape returns.
  await bold.focus()
  await page.keyboard.press('ArrowRight')
  await expect(toolbar.locator('[data-control-id="toolbar.italic"]')).toBeFocused()
  // Radix moves focus on a timer, so wait for each step like a human would.
  for (const id of ['underline', 'bulletList', 'orderedList']) {
    await page.keyboard.press('ArrowRight')
    await expect(toolbar.locator(`[data-control-id="toolbar.${id}"]`)).toBeFocused()
  }
  await page.keyboard.press('Enter')
  await expect(editor.locator('ol')).toHaveCount(1)
  await expect(toolbar.locator('[data-control-id="toolbar.orderedList"]')).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(editor).toBeFocused()
})

test('toolbar controls have 32px targets and wrap at narrow widths', async ({ page }) => {
  await page.setViewportSize({ width: 380, height: 700 })
  await page.goto('/')
  const toolbar = page.getByRole('toolbar', { name: 'Formatting' })
  const controls = toolbar.locator('[data-control-id]')
  // 16 formatting controls + 4 in the Styles group + undo, redo, find.open + book.trimSize + book.headerFooter +
  // insert.menu + footnote.options + the paper picker (group + 4 options) + settings.open +
  // comment.new + comment.panel + review.track + review.markup, wired in App; waits for the app to boot.
  await expect(controls).toHaveCount(37)
  const n = await controls.count()
  for (let i = 0; i < n; i++) {
    const box = await controls.nth(i).boundingBox()
    expect(box!.height).toBeGreaterThanOrEqual(32)
    expect(box!.width).toBeGreaterThanOrEqual(32)
  }
  const scrollW = await page.evaluate(() => document.documentElement.scrollWidth)
  expect(scrollW).toBeLessThanOrEqual(380)
  await page.screenshot({ path: 'test-results/toolbar-380.png' })
  await page.setViewportSize({ width: 1200, height: 700 })
  await page.screenshot({ path: 'test-results/toolbar-1200.png' })
})
