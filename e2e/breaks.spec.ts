import { expect, test, type Page } from '@playwright/test'
import { editor, launch, newProject } from './helpers'

const insert = (page: Page) => page.locator('[data-control-id="insert.menu"]')
const item = (page: Page, id: string) => page.locator(`[data-control-id="${id}"]`)
const surface = (page: Page) => page.locator('.novel-editor-content')

async function choose(page: Page, id: string) {
  await insert(page).click()
  await item(page, id).click()
}

test('Insert menu adds a page break, a chapter and a scene break', async ({ page }) => {
  await launch(page)
  await newProject(page, '/projects/Breaks')
  await editor(page).click()
  await page.keyboard.type('Opening text')
  await choose(page, 'insert.pageBreak')
  await page.keyboard.type('After the break')
  await expect(surface(page).locator('[data-page-break]')).toHaveCount(1)
  await expect(surface(page).locator('[data-break-before="page"]')).toContainText('After the break')

  await page.keyboard.press('Enter')
  await choose(page, 'insert.newChapter')
  await page.keyboard.type('The Storm')
  await expect(surface(page).locator('h1[data-style="chapter-title"]')).toHaveText('The Storm')
  await expect(surface(page).locator('h1')).toHaveAttribute('data-break-before', 'page')

  await page.keyboard.press('Enter')
  await choose(page, 'insert.sceneBreak')
  await expect(surface(page).locator('[data-scene-break]')).toHaveText('* * *')
  await expect(surface(page).locator('[data-scene-break]')).not.toHaveAttribute('data-break-before', /.*/)
  await page.keyboard.type('Later that night')
  await expect(surface(page).locator('[data-style="first-paragraph"]')).toContainText('Later that night')
})

test('shortcuts, *** rule with one undo, and deleting a selected page break', async ({ page }) => {
  await launch(page)
  await newProject(page, '/projects/Keys2')
  await editor(page).click()
  await page.keyboard.type('One')
  await page.keyboard.press('ControlOrMeta+Enter')
  await expect(surface(page).locator('[data-page-break]')).toHaveCount(1)
  await page.keyboard.press('Backspace') // selects the break (atom before the caret)
  await page.keyboard.press('Backspace') // deletes it
  await expect(surface(page).locator('[data-page-break]')).toHaveCount(0)

  await page.keyboard.press('ControlOrMeta+Shift+Enter')
  await expect(surface(page).locator('[data-style="chapter-title"]')).toHaveCount(1)
  await page.keyboard.press('ControlOrMeta+z')
  await page.keyboard.press('Enter')
  await page.keyboard.type('***')
  await expect(surface(page).locator('[data-scene-break]')).toHaveCount(1)
  await page.keyboard.press('ControlOrMeta+z')
  await expect(surface(page).locator('[data-scene-break]')).toHaveCount(0)
})

test('Chapters start on right-hand page updates the break, and the menu passes the tooltip audit', async ({ page }) => {
  await launch(page)
  await newProject(page, '/projects/Recto')
  await editor(page).click()
  await page.keyboard.press('ControlOrMeta+Shift+Enter')
  await page.keyboard.type('Chapter')
  await expect(surface(page).locator('h1')).toHaveAttribute('data-break-before', 'page')

  await insert(page).hover()
  await expect(page.locator('[data-tooltip-body]')).toContainText('page break')
  await insert(page).click()
  expect(await page.evaluate(() => window.__nvE2E.auditTooltips())).toEqual([])
  await item(page, 'insert.chapterStart.recto').click()
  await expect(surface(page).locator('h1')).toHaveAttribute('data-break-before', 'recto')
  await insert(page).click()
  await expect(item(page, 'insert.chapterStart.recto')).toHaveAttribute('aria-checked', 'true')
})

test('the Insert menu is keyboard operable', async ({ page }) => {
  await launch(page)
  await newProject(page, '/projects/KeyMenu')
  await insert(page).focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('menuitem')).toHaveCount(3)
  await page.keyboard.press('Enter')
  await expect(surface(page).locator('[data-page-break]')).toHaveCount(1)
})
