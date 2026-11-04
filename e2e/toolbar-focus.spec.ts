import { expect, test } from '@playwright/test'
import { launch } from './helpers'

/**
 * Regression (macOS Chromium CI, project.spec): a pointer click on a formatting button left focus on
 * the button until the command's deferred editor focus ran (next animation frame). Typing that
 * started sooner went to the button; Space and Enter re-activated it, toggling the list off and
 * dropping the text. The button must never take focus from the manuscript on a pointer press.
 */
test('a click on a formatting button keeps the manuscript focused; typing right after it is kept', async ({ page, browserName }) => {
  await launch(page)
  const ed = page.getByRole('textbox', { name: 'Manuscript' })
  await ed.click()
  await page.keyboard.type('It was a dark night.')
  await page.keyboard.press('Enter')

  // Where focus is at the moment the click event fires (before any frame runs).
  await page.evaluate(() => {
    const w = window as unknown as { __focusAtClick: string[] }
    w.__focusAtClick = []
    document.addEventListener(
      'click',
      () => w.__focusAtClick.push(document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.tagName ?? ''),
      true,
    )
  })
  // Slow frames make the deferred-focus window long (Chromium only: CDP throttling).
  if (browserName === 'chromium') {
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 })
  }
  await page.locator('[data-control-id="toolbar.bulletList"]').click()
  expect(await page.evaluate(() => (window as unknown as { __focusAtClick: string[] }).__focusAtClick)).toEqual(['Manuscript'])
  await page.keyboard.type('first item')
  await page.keyboard.press('Enter')
  await page.keyboard.type('second item')
  await expect(ed.locator('ul > li')).toHaveCount(2)
  await expect(ed.locator('ul > li').nth(0)).toHaveText('first item')
  await expect(ed.locator('ul > li').nth(1)).toHaveText('second item')
  await expect(ed).toBeFocused()
})
