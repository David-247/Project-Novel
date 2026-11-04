import { expect, test, type Page } from '@playwright/test'
import { launch } from './helpers'

const html = (page: Page) => page.locator('html')
const radio = (page: Page, value: string) => page.locator(`[data-control-id="book.surface.${value}"]`)
const pageBg = (page: Page) =>
  page.getByTestId('writing-surface').evaluate((el) => getComputedStyle(el).backgroundColor)
const deskBg = (page: Page) => page.locator('main').evaluate((el) => getComputedStyle(el).backgroundColor)

test('auto paper follows the OS light/dark mode live', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' })
  await launch(page)
  await expect(html(page)).toHaveAttribute('data-surface', 'white')
  await expect(radio(page, 'auto')).toHaveAttribute('aria-checked', 'true')
  expect(await pageBg(page)).toBe('rgb(255, 255, 255)')

  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(html(page)).toHaveAttribute('data-surface', 'dark')
  await expect.poll(() => pageBg(page)).toBe('rgb(32, 35, 39)')

  await page.emulateMedia({ colorScheme: 'light' })
  await expect(html(page)).toHaveAttribute('data-surface', 'white')
})

test('the picker switches paper instantly and book keeps its look in both OS modes', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' })
  await launch(page)

  const metrics = () =>
    page.getByTestId('writing-surface').evaluate((el) => {
      const r = el.getBoundingClientRect()
      const cs = getComputedStyle(el.querySelector('.novel-editor-content')!)
      return { w: r.width, h: r.height, font: cs.fontSize, lh: cs.lineHeight }
    })
  const before = await metrics()

  await radio(page, 'book').click()
  await expect(html(page)).toHaveAttribute('data-surface', 'book')
  await expect(radio(page, 'book')).toHaveAttribute('aria-checked', 'true')
  const bookLight = await pageBg(page)
  expect(bookLight).toBe('rgb(244, 234, 210)')
  expect(await deskBg(page)).toBe('rgb(191, 178, 154)')
  expect(await metrics()).toEqual(before) // colours only: no reflow

  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(html(page)).toHaveAttribute('data-surface', 'book')
  await expect.poll(() => pageBg(page)).toBe('rgb(43, 37, 32)') // warm dark variant

  await radio(page, 'white').click()
  await expect.poll(() => pageBg(page)).toBe('rgb(255, 255, 255)')
  await radio(page, 'dark').click()
  await expect.poll(() => pageBg(page)).toBe('rgb(32, 35, 39)')
  await radio(page, 'auto').click()
  await expect(html(page)).toHaveAttribute('data-surface', 'dark')
})

test('the picker is reachable and operable by keyboard', async ({ page }) => {
  await launch(page)
  await radio(page, 'auto').focus()
  await page.keyboard.press('ArrowRight')
  await expect(radio(page, 'book')).toBeFocused()
  // Keyboard focus shows the tooltip.
  await expect(page.locator('[data-tooltip-body]')).toContainText('Cream paper')
  await page.keyboard.press('Enter')
  await expect(html(page)).toHaveAttribute('data-surface', 'book')
})
