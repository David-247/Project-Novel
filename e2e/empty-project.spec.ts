import { expect, test } from '@playwright/test'
import { editor, launch, nativeDialog, newProject, openRecent, readFile, saveStatus, seedProject } from './helpers'

test('new project starts with an empty document; saving it and reopening it work', async ({ page, context }) => {
  await launch(page)
  await newProject(page, '/projects/Blank')
  await expect(editor(page)).toHaveText('')
  await expect(editor(page).locator('p')).toHaveCount(1)
  await expect(page.locator('[data-control-id="history.undo"]')).toBeDisabled()

  // Save an empty, unchanged document.
  await editor(page).click()
  await page.keyboard.press('ControlOrMeta+s')
  await expect(saveStatus(page)).toHaveText('Blank: Saved')
  await expect(nativeDialog(page)).toHaveCount(0)
  const saved = JSON.parse((await readFile(page, '/projects/Blank/manuscript.json'))!)
  expect(saved.type).toBe('doc')

  // Type, then delete everything, then save: still a valid empty document.
  await page.keyboard.type('temporary')
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.press('Backspace')
  await expect(editor(page)).toHaveText('')
  await page.keyboard.press('ControlOrMeta+s')
  await expect(saveStatus(page)).toHaveText('Blank: Saved')

  await page.close()
  const relaunched = await context.newPage()
  await launch(relaunched)
  await openRecent(relaunched, '/projects/Blank')
  await expect(saveStatus(relaunched)).toHaveText('Blank: All changes saved')
  await expect(editor(relaunched)).toHaveText('')
  await expect(nativeDialog(relaunched)).toHaveCount(0)
  await expect(relaunched.getByRole('dialog')).toHaveCount(0)
})

test('find and replace in an empty document', async ({ page }) => {
  await launch(page)
  await newProject(page, '/projects/Nothing')
  await editor(page).click()
  await page.keyboard.press('ControlOrMeta+f')
  const panel = page.getByRole('region', { name: 'Find and replace' })
  await panel.getByRole('textbox', { name: 'Find' }).fill('anything')
  await expect(page.getByTestId('find-status')).toHaveText('No results')
  await panel.getByRole('textbox', { name: 'Replace with' }).fill('else')
  await expect(panel.getByRole('button', { name: 'Replace all' })).toBeDisabled()
  await expect(panel.locator('[data-control-id="find.next"]')).toBeDisabled()
  await page.keyboard.press('Escape')
  await expect(editor(page)).toHaveText('')
  await expect(saveStatus(page)).toHaveText('Nothing: All changes saved')
})

test('a manuscript with no blocks opens as an empty document', async ({ page }) => {
  await launch(page)
  await seedProject(page, '/projects/Hollow', 'Hollow', { type: 'doc', content: [] })
  await openRecent(page, '/projects/Hollow')
  await expect(saveStatus(page)).toHaveText('Hollow: All changes saved')
  await expect(nativeDialog(page)).toHaveCount(0)
  await editor(page).click()
  await page.keyboard.type('Now there is text.')
  await expect(editor(page)).toHaveText('Now there is text.')
})
