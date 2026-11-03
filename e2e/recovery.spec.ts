import { expect, test } from '@playwright/test'
import { editor, launch, newProject, openRecent, recoveryControl, saveStatus, seedProject, writeFile } from './helpers'

// Autosave snapshots at most every 30 s. Playwright's fake clock (time flows normally, and
// runFor() jumps ahead) fires the 30 s timer without waiting 30 s of real time.
test('force-kill after an autosave, relaunch: Restore recovers the text typed up to the last autosave', async ({
  page,
  context,
}) => {
  await page.clock.install()
  await launch(page)
  await newProject(page, '/projects/Crashy')
  const ed = editor(page)
  await ed.click()
  await page.keyboard.type('Saved paragraph.')
  await page.keyboard.press('ControlOrMeta+s')
  await expect(saveStatus(page)).toHaveText('Crashy: Saved')

  await page.keyboard.press('Enter')
  await page.keyboard.type('Typed before the autosave.')
  await expect(saveStatus(page)).toHaveText('Crashy: Unsaved changes')
  await page.clock.runFor(31_000)
  await expect(saveStatus(page)).toHaveText(/^Crashy: Unsaved changes · backed up \d/)

  // Typed after the last autosave: allowed to be lost (< 30 s of work).
  await page.keyboard.press('Enter')
  await page.keyboard.type('Typed after the autosave.')

  // Force-kill: no beforeunload, no quit flow.
  await page.close({ runBeforeUnload: false })

  const relaunched = await context.newPage()
  await launch(relaunched)
  // Startup: the last project has a backup left by the crash.
  await expect(relaunched.getByRole('dialog', { name: 'Recover unsaved work?' })).toBeVisible()
  await recoveryControl(relaunched, 'reopen').click()
  // Opened: the backup is newer than the last save.
  const restoreDialog = relaunched.getByRole('dialog', { name: 'Restore unsaved changes?' })
  await expect(restoreDialog).toBeVisible()
  // Until the user decides, the saved version is shown (behind the modal, so not via its role).
  await expect(relaunched.locator('main [contenteditable="true"]')).toHaveText('Saved paragraph.')
  await recoveryControl(relaunched, 'restore').click()
  await expect(restoreDialog).toHaveCount(0)

  const paragraphs = editor(relaunched).locator('p')
  await expect(paragraphs).toHaveText(['Saved paragraph.', 'Typed before the autosave.'])
  // Restored text is unsaved until the user saves it.
  await expect(saveStatus(relaunched)).toContainText('Crashy: Unsaved changes')
  await relaunched.keyboard.press('ControlOrMeta+s')
  await expect(saveStatus(relaunched)).toHaveText('Crashy: Saved')

  // After saving, a further relaunch opens cleanly with no recovery prompt.
  await relaunched.close({ runBeforeUnload: false })
  const third = await context.newPage()
  await launch(third)
  await expect(third.getByRole('dialog')).toHaveCount(0)
})

test('Discard Backup keeps the last saved version', async ({ page, context }) => {
  await page.clock.install()
  await launch(page)
  await newProject(page, '/projects/Discard')
  await editor(page).click()
  await page.keyboard.type('Kept.')
  await page.keyboard.press('ControlOrMeta+s')
  await expect(saveStatus(page)).toHaveText('Discard: Saved')
  await page.keyboard.type(' Thrown away.')
  await page.clock.runFor(31_000)
  await expect(saveStatus(page)).toHaveText(/^Discard: Unsaved changes · backed up \d/)
  await page.close({ runBeforeUnload: false })

  const relaunched = await context.newPage()
  await launch(relaunched)
  await recoveryControl(relaunched, 'reopen').click()
  await expect(relaunched.getByRole('dialog', { name: 'Restore unsaved changes?' })).toBeVisible()
  await recoveryControl(relaunched, 'discard').click()
  await expect(relaunched.getByRole('dialog')).toHaveCount(0)
  await expect(editor(relaunched)).toHaveText('Kept.')
  await expect(saveStatus(relaunched)).toHaveText('Discard: All changes saved')
})

test('"Decide later" leaves a status-bar "Backup available — Restore…" that re-opens the question', async ({
  page,
  context,
}) => {
  await page.clock.install()
  await launch(page)
  await newProject(page, '/projects/Later')
  await editor(page).click()
  await page.keyboard.type('Saved.')
  await page.keyboard.press('ControlOrMeta+s')
  await expect(saveStatus(page)).toHaveText('Later: Saved')
  await page.keyboard.type(' Backed up.')
  await page.clock.runFor(31_000)
  await expect(saveStatus(page)).toContainText('backed up')
  await page.close({ runBeforeUnload: false })

  const relaunched = await context.newPage()
  await launch(relaunched)
  await recoveryControl(relaunched, 'reopen').click()
  const restoreDialog = relaunched.getByRole('dialog', { name: 'Restore unsaved changes?' })
  await expect(restoreDialog).toBeVisible()
  await recoveryControl(relaunched, 'decideLater').click()
  await expect(restoreDialog).toHaveCount(0)

  const later = recoveryControl(relaunched, 'reopenPrompt')
  await expect(later).toHaveText('Backup available — Restore…')
  await later.click()
  await expect(restoreDialog).toBeVisible()
  await recoveryControl(relaunched, 'restore').click()
  await expect(editor(relaunched)).toHaveText('Saved. Backed up.')
  await expect(later).toHaveCount(0)
})

test('set-aside unrestored backups are mentioned on open, without a dialog', async ({ page }) => {
  await launch(page)
  const doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }] }
  await seedProject(page, '/projects/Aside', 'Aside', doc)
  await writeFile(page, '/projects/Aside/.recovery/unrestored-2026-01-01T00-00-00-000Z.json', '{}')
  await openRecent(page, '/projects/Aside')
  await expect(saveStatus(page)).toHaveText('Aside: All changes saved')
  await expect(page.getByTestId('recovery-notice')).toHaveText("1 older backup is kept in this project's .recovery folder.")
  await expect(page.getByRole('dialog')).toHaveCount(0)
})
