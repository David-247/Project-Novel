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

test('ribbon controls have 32px targets, one row and no horizontal scroll at the minimum width', async ({ page }) => {
  await page.setViewportSize({ width: 2400, height: 700 })
  await page.goto('/')
  const toolbar = page.getByRole('toolbar', { name: 'Formatting' })
  // Every tab stays mounted, so the toolbar holds every control at a wide window (69): 5 tabs, 16 formatting
  // controls + 4 Styles + undo, redo, find.open, Replace (Home); insert.menu + 3 break buttons +
  // footnote.options + Footnote + Comment (Insert); book.trimSize + book.headerFooter + the paper picker
  // (group + 4 options) + Book Details (Layout); review.track + review.markup + comment.new + Previous /
  // Next Comment + Show Resolved Comments + Previous / Next Change + Accept and Reject split buttons (2 halves
  // each) + Re-write Passage, Re-writes, Previous / Next Re-write (Review); Single Page, Two-Page Spread, 5 zoom buttons, comment.panel, Full Screen (View).
  // (5 + 24 + 7 + 8 + 16 + 9.)
  await expect(toolbar.locator('[data-control-id]')).toHaveCount(69)
  await expect(toolbar.locator('[data-control-id^="ribbon.group."], [data-control-id="ribbon.more"]')).toHaveCount(0)

  await page.setViewportSize({ width: 480, height: 700 })
  const header = page.getByRole('banner', { name: 'App controls' })
  for (const tab of ['home', 'insert', 'layout', 'review', 'view'] as const) {
    await page.locator(`[data-control-id="ribbon.tab.${tab}"]`).click()
    const visible = toolbar.locator('[data-control-id]:visible')
    expect(await visible.count()).toBeGreaterThan(5)
    for (const box of await visible.evaluateAll((els) => els.map((e) => e.getBoundingClientRect().toJSON() as DOMRect))) {
      expect(box.height).toBeGreaterThanOrEqual(32)
      expect(box.width).toBeGreaterThanOrEqual(32)
      expect(box.right).toBeLessThanOrEqual(480)
    }
    expect((await header.boundingBox())!.height).toBeLessThan(90)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(480)
  }
})
