import { expect, test } from '@playwright/test'
import { editor, launch, newProject, reveal, seedPreferences, waitForLayout } from './helpers'

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

/**
 * The slices' own motion (a comment card sliding to its anchor, the re-write view's spine stitches)
 * follows Settings > Motion too, not the OS query: with the OS set to reduce motion, 'Allow motion'
 * keeps their 120 ms transitions and 'Follow system' / 'Reduce motion' stop them.
 */
for (const [pref, reduced] of [
  ['off', false],
  ['system', true],
  ['on', true],
] as const) {
  test(`OS reduce motion + Settings reduceMotion '${pref}': comment card and re-write view motion ${reduced ? 'stopped' : 'allowed'}`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await seedPreferences(page, { reduceMotion: pref })
    await launch(page)
    await expect(page.locator('html')).toHaveAttribute('data-reduce-motion', reduced ? 'on' : 'off')
    await newProject(page, `/projects/Motion-${pref}`)
    const para = (t: string) => ({ type: 'paragraph', content: [{ type: 'text', text: t }] })
    await page.evaluate(
      (d) => window.__nvE2E.setDoc(d),
      { type: 'doc', content: [para('The rain came at dusk, soft at first.'), para('She closed the window.'), para('Nobody spoke.')] },
    )
    await waitForLayout(page)
    const expected = reduced ? '0s' : '0.12s'

    // A comment card.
    await editor(page).click()
    await page.evaluate(() => window.__nvE2E.selectText(5, 9))
    await (await reveal(page, 'comment.new')).click()
    const field = page.locator('[data-control-id="comment.composeField"]')
    await expect(field).toBeFocused()
    await field.fill('Motion check')
    await page.keyboard.press('ControlOrMeta+Enter')
    await expect(field).toHaveCount(0)
    const slot = page.locator('.nv-comment-slot').first()
    await expect(slot).toBeAttached()
    expect(await slot.evaluate((el) => getComputedStyle(el).transitionDuration)).toBe(expected)

    // The re-write view's spine.
    await editor(page).click()
    await page.evaluate(() => {
      const e = window.__nvE2E
      e.selectText(e.blockPos(0) + 3, e.blockPos(1) + 3)
    })
    await page.keyboard.press('ControlOrMeta+Alt+w')
    await expect(page.getByTestId('rewrite-view')).toBeVisible()
    const stitch = page.locator('.nv-rw-stitch').first()
    await expect(stitch).toBeAttached()
    expect(await stitch.evaluate((el) => getComputedStyle(el).transitionDuration)).toBe(expected)
  })
}
