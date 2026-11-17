import { expect, test } from '@playwright/test'
import { launch, seedPreferences } from './helpers'

test('UI follows OS light/dark live', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' })
  await page.goto('/')
  const html = page.locator('html')
  await expect(html).toHaveAttribute('data-theme', 'light')
  const lightBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)

  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(html).toHaveAttribute('data-theme', 'dark')
  await expect
    .poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor))
    .not.toBe(lightBg)

  await page.emulateMedia({ colorScheme: 'light' })
  await expect(html).toHaveAttribute('data-theme', 'light')
})

/**
 * Settings > Motion against the OS Reduce motion setting (review: 'Allow motion' must override it).
 * An element with no transition of its own must compute a zero duration (an OS-keyed 0.01 ms rule on
 * `*` made every changed property of every element transition: slow reflows in WebKit), and the
 * dialog's entrance animation follows the app setting, not the OS one.
 */
for (const [pref, reduced] of [
  ['off', false],
  ['system', true],
  ['on', true],
] as const) {
  test(`OS reduce motion + Settings reduceMotion '${pref}': motion ${reduced ? 'stopped' : 'allowed'}`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await seedPreferences(page, { reduceMotion: pref })
    await launch(page)
    const html = page.locator('html')
    if (reduced) await expect(html).toHaveAttribute('data-reduce-motion', 'on')
    else await expect(html).not.toHaveAttribute('data-reduce-motion', 'on')
    // No element without a transition of its own transitions anything.
    const durations = await page.evaluate(() =>
      [document.body, document.querySelector('.ProseMirror')!, document.querySelector('.ProseMirror > *')!].map((el) => getComputedStyle(el).transitionDuration),
    )
    expect(durations).toEqual(['0s', '0s', '0s'])
    // The dialog's entrance animation: on with 'Allow motion' despite the OS setting, off otherwise.
    await page.locator('[data-control-id="menu.file"]').click()
    await page.locator('[role="menu"] [data-control-id="settings.open"]').click()
    const dialog = page.getByRole('dialog', { name: 'Settings' })
    await expect(dialog).toBeVisible()
    expect(await dialog.evaluate((el) => getComputedStyle(el).animationName)).toBe(reduced ? 'none' : 'nv-rise')
  })
}
