import { expect, test } from '@playwright/test'

test('shell renders toolbar and editor regions', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('banner', { name: 'App controls' })).toBeVisible()
  await expect(page.getByRole('main', { name: 'Editor' })).toBeVisible()
})
