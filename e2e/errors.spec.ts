import { expect, test } from '@playwright/test'
import { editor, launch, nativeDialog, newProject, openRecent, saveStatus, seedProject } from './helpers'

const doc = (text: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] })

test('a corrupt manuscript.json shows an error dialog, not a crash', async ({ page }) => {
  await launch(page)
  await seedProject(page, '/projects/Broken', 'Broken', null, '{"type":"doc","content":[{"type":"paragr')
  await seedProject(page, '/projects/Alien', 'Alien', { type: 'doc', content: [{ type: 'spaceship' }] })

  await openRecent(page, '/projects/Broken')
  await expect(nativeDialog(page)).toHaveAttribute('aria-label', 'Could not open project')
  await expect(nativeDialog(page)).toContainText('manuscript.json is damaged and could not be read (it is not valid JSON).')
  await expect(nativeDialog(page)).toHaveAttribute('data-kind', 'error')
  await nativeDialog(page).getByRole('button', { name: 'OK' }).click()
  await expect(saveStatus(page)).toHaveText('No project open')

  // Valid JSON the editor schema rejects.
  await openRecent(page, '/projects/Alien')
  await expect(nativeDialog(page)).toContainText('manuscript.json is damaged: it contains content Novel cannot display.')
  await nativeDialog(page).getByRole('button', { name: 'OK' }).click()
  await expect(saveStatus(page)).toHaveText('No project open')

  // The app still works.
  await editor(page).click()
  await page.keyboard.type('Still alive.')
  await expect(editor(page)).toHaveText('Still alive.')
})

test('a failed save (disk full) shows an error, keeps the text, and a later save succeeds', async ({ page }) => {
  await launch(page)
  await newProject(page, '/projects/Full')
  await editor(page).click()
  await page.keyboard.type('Precious words.')
  await page.evaluate(() => window.__nvE2E.setFailWrite('manuscript.json', 'disk_full'))
  await page.keyboard.press('ControlOrMeta+s')
  await expect(nativeDialog(page)).toHaveAttribute('aria-label', 'Could not save')
  await expect(nativeDialog(page)).toContainText('The disk is full, so manuscript.json could not be saved.')
  await nativeDialog(page).getByRole('button', { name: 'OK' }).click()
  await expect(saveStatus(page)).toHaveText('Full: Save failed')
  await expect(editor(page)).toHaveText('Precious words.')

  await page.evaluate(() => window.__nvE2E.setFailWrite(null))
  await page.keyboard.press('ControlOrMeta+s')
  await expect(saveStatus(page)).toHaveText('Full: Saved')
})

test('a read-only or write-denied project folder: save error names the cause', async ({ page }) => {
  await launch(page)
  await newProject(page, '/projects/Locked')
  await editor(page).click()
  await page.keyboard.type('x')
  await page.evaluate(() => window.__nvE2E.setFailWrite('/projects/Locked/', 'read_only'))
  await page.keyboard.press('ControlOrMeta+s')
  await expect(nativeDialog(page)).toContainText(
    'Novel could not write manuscript.json because the project folder is read-only.',
  )
  await nativeDialog(page).getByRole('button', { name: 'OK' }).click()
  await expect(saveStatus(page)).toHaveText('Locked: Save failed')

  // Permission denied (Windows also reports a file in use by another program this way).
  await page.evaluate(() => window.__nvE2E.setFailWrite('/projects/Locked/', 'permission_denied'))
  await page.keyboard.press('ControlOrMeta+s')
  await expect(nativeDialog(page)).toContainText(
    'Novel could not write manuscript.json. The project folder may be read-only, or the file is in use by another program.',
  )
  await nativeDialog(page).getByRole('button', { name: 'OK' }).click()
  await expect(saveStatus(page)).toHaveText('Locked: Save failed')
})

test('failing autosave shows a non-blocking warning and recovers', async ({ page }) => {
  await page.clock.install()
  await launch(page)
  await newProject(page, '/projects/Flaky')
  await editor(page).click()
  await page.evaluate(() => window.__nvE2E.setFailWrite('.recovery', 'disk_full'))
  await page.keyboard.type('Typing on.')
  await page.clock.runFor(31_000)
  const warning = page.getByTestId('autosave-warning')
  await expect(warning).toHaveText('Autosave failed: the disk is full. Retrying in 5 s.')
  // Non-blocking: no dialog, typing continues.
  await expect(nativeDialog(page)).toHaveCount(0)
  await page.keyboard.type(' More.')
  await page.evaluate(() => window.__nvE2E.setFailWrite(null))
  await page.clock.runFor(6_000)
  await expect(warning).toHaveCount(0)
  await expect(saveStatus(page)).toHaveText('Flaky: Unsaved changes (backed up)')
})

test('opening a project shows "Opening…" until it is loaded', async ({ page }) => {
  await launch(page)
  await seedProject(page, '/projects/Slow', 'Slow', doc('Loaded at last.'))
  await page.evaluate(() => window.__nvE2E.setReadDelay(700))
  await openRecent(page, '/projects/Slow')
  await expect(saveStatus(page)).toHaveText('Opening…')
  await expect(saveStatus(page)).toHaveText('Slow: All changes saved')
  await expect(editor(page)).toHaveText('Loaded at last.')
})

test('font picker lists installed fonts, and says so when they cannot be listed', async ({ page, context }) => {
  await launch(page)
  const picker = page.getByRole('combobox', { name: 'Font family' })
  await expect(picker.locator('option')).toHaveText(['System default', 'E2E Serif', 'E2E Sans'])

  await context.addInitScript(() => {
    ;(window as unknown as { __nvE2EConfig: unknown }).__nvE2EConfig = { failFonts: true }
  })
  await launch(page)
  await expect(picker.locator('option')).toHaveText(['System default (installed fonts unavailable)'])
  await expect(picker).toBeEnabled()
  // Writing still works in the system font.
  await editor(page).click()
  await page.keyboard.type('Plain system font.')
  await expect(editor(page)).toHaveText('Plain system font.')
})
