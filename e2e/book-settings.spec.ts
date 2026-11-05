import { expect, test, type Page } from '@playwright/test'
import { editor, launch, newProject, openRecent, readFile, recoveryControl, saveStatus, reveal } from './helpers'

const picker = (page: Page) => reveal(page, 'book.trimSize')
const menuItem = (page: Page, name: RegExp) => page.getByRole('menuitemradio', { name })

async function choose(page: Page, name: RegExp) {
  await (await picker(page)).click()
  await menuItem(page, name).click()
}

test('the trim size picker updates the setting, marks the project unsaved and survives save and reopen', async ({ page }) => {
  await launch(page)
  await newProject(page, '/projects/Trim')
  await expect((await picker(page))).toContainText('Trade')
  await expect(saveStatus(page)).toHaveText('Trim: All changes saved')

  await choose(page, /A5/)
  await expect((await picker(page))).toContainText('148 x 210 mm')
  await expect(saveStatus(page)).toHaveText('Trim: Unsaved changes')

  await page.keyboard.press('ControlOrMeta+s')
  await expect(saveStatus(page)).toHaveText('Trim: Saved')
  expect(JSON.parse((await readFile(page, '/projects/Trim/book.json'))!).trimSize).toBe('uk-a5')

  // Close and reopen (relaunch: fresh app state, same disk).
  await page.reload()
  await launch(page)
  await openRecent(page, '/projects/Trim')
  await expect(saveStatus(page)).toContainText('Trim:')
  await expect((await picker(page))).toContainText('A5')
})

test('menu is grouped US / UK/EU and fully keyboard operable', async ({ page }) => {
  await launch(page)
  await newProject(page, '/projects/Keys')
  await (await picker(page)).focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('group', { name: 'US', exact: true })).toBeVisible()
  await expect(page.getByRole('group', { name: 'UK/EU', exact: true })).toBeVisible()
  await expect(page.getByRole('menuitemradio')).toHaveCount(9)
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect((await picker(page))).not.toContainText('Trade')
  await expect((await picker(page))).toBeFocused()
  await expect(saveStatus(page)).toHaveText('Keys: Unsaved changes')
})

test('tooltip on the picker, and the coverage audit passes closed and with the menu open', async ({ page }) => {
  await launch(page)
  await newProject(page, '/projects/Tip')
  await (await picker(page)).hover()
  await expect(page.locator('[data-tooltip-body]')).toContainText('Page size of the printed book')
  expect(await page.evaluate(() => window.__nvE2E.auditTooltips())).toEqual([])
  await (await picker(page)).click()
  await expect(page.getByRole('menuitemradio')).toHaveCount(9)
  expect(await page.evaluate(() => window.__nvE2E.auditTooltips())).toEqual([])
})

test('crash recovery restores an unsaved trim size together with the text', async ({ page, context }) => {
  await page.clock.install()
  await launch(page)
  await newProject(page, '/projects/Crash')
  await editor(page).click()
  await page.keyboard.type('Draft.')
  await choose(page, /Royal/)
  await page.clock.runFor(31_000)
  await expect(saveStatus(page)).toHaveText(/^Crash: Unsaved changes · backed up \d/)

  await page.close({ runBeforeUnload: false })
  const relaunched = await context.newPage()
  await launch(relaunched)
  await recoveryControl(relaunched, 'reopen').click()
  await recoveryControl(relaunched, 'restore').click()
  await expect(editor(relaunched).locator('p')).toHaveText(['Draft.'])
  await expect((await picker(relaunched))).toContainText('Royal')
  await expect(saveStatus(relaunched)).toContainText('Crash: Unsaved changes')
})
