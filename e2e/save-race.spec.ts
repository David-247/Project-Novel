import { expect, test, type Page } from '@playwright/test'
import { editor, launch, nativeDialog, newProject, saveStatus, waitForLayout } from './helpers'

/**
 * A Save right after typing in a re-write's revision (before its 400 ms copy into the store): the
 * revision is flushed before the save reads the document version, so the project ends up saved and
 * quitting asks nothing (final review storage #1 / rewrite #2).
 */

const revision = (page: Page) => page.getByRole('textbox', { name: 'Revised passage' })
const p = (t: string) => ({ type: 'paragraph', content: [{ type: 'text', text: t }] })
const DOC = { type: 'doc', content: [p('The rain came at dusk.'), p('She closed the window.'), p('Nobody spoke.')] }

async function typedJustBeforeSave(page: Page, name: string) {
  await launch(page)
  await newProject(page, `/projects/${name}`)
  await page.evaluate((d) => window.__nvE2E.setDoc(d), DOC)
  await waitForLayout(page)
  await editor(page).click()
  await page.evaluate(() => window.__nvE2E.selectText(window.__nvE2E.blockPos(0) + 3, window.__nvE2E.blockPos(1) + 3))
  await page.keyboard.press('ControlOrMeta+Alt+w')
  await expect(revision(page)).toBeFocused()
  // Let the opening settle, then type and save inside one flush window (no New Version first).
  await page.keyboard.press('ControlOrMeta+s')
  await expect(saveStatus(page)).toHaveText(`${name}: Saved`)
  await page.keyboard.type('Late ')
  await page.keyboard.press('ControlOrMeta+s')
}

test('Mod-s within 100 ms of typing in the revision saves the project, and quitting asks nothing', async ({ page }) => {
  await page.clock.install()
  await typedJustBeforeSave(page, 'Race')
  await expect(saveStatus(page)).toHaveText('Race: Saved')
  const saved = JSON.parse((await page.evaluate(() => window.__nvE2E.readFile('/projects/Race/rewrites.json')))!)
  expect(saved.rewrites[0].versions[0].doc.content[0].content[0].text).toMatch(/^Late The rain/)
  // Long after the flush window: still saved.
  await page.clock.runFor(1_000)
  await expect(saveStatus(page)).toHaveText('Race: Saved')
  await page.evaluate(() => window.__nvE2E.emit('menu://quit'))
  await expect.poll(() => page.evaluate(() => window.__nvE2E.exits())).toBe(1)
  await expect(nativeDialog(page)).toHaveCount(0)
})

test('Save in the quit prompt within the flush window quits without "could not be saved"', async ({ page }) => {
  await page.clock.install()
  await launch(page)
  await newProject(page, '/projects/Prompt')
  await page.evaluate((d) => window.__nvE2E.setDoc(d), DOC)
  await waitForLayout(page)
  await editor(page).click()
  await page.evaluate(() => window.__nvE2E.selectText(window.__nvE2E.blockPos(0) + 3, window.__nvE2E.blockPos(1) + 3))
  await page.keyboard.press('ControlOrMeta+Alt+w')
  await expect(revision(page)).toBeFocused()
  await page.keyboard.type('Late ')
  await page.evaluate(() => window.__nvE2E.emit('menu://quit'))
  await expect(nativeDialog(page)).toBeVisible()
  await nativeDialog(page).getByRole('button', { name: 'Save', exact: true }).click()
  await expect.poll(() => page.evaluate(() => window.__nvE2E.exits())).toBe(1)
  await expect(nativeDialog(page)).toHaveCount(0)
  const saved = JSON.parse((await page.evaluate(() => window.__nvE2E.readFile('/projects/Prompt/rewrites.json')))!)
  expect(saved.rewrites[0].versions[0].doc.content[0].content[0].text).toMatch(/^Late The rain/)
})
