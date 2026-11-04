import { expect, test } from '@playwright/test'
import { editor, editorHTML, launch, newProject, openRecent, readFile, saveStatus, seedProject } from './helpers'

test('create a project, type formatted text, save with Mod-S, relaunch and reopen from the recent list', async ({
  page,
  context,
}) => {
  await launch(page)
  await expect(saveStatus(page)).toHaveText('No project open')

  // File > New Project; the native folder dialog returns /projects/My Novel.
  await newProject(page, '/projects/My Novel')
  await expect(saveStatus(page)).toHaveText('My Novel: All changes saved')
  expect(await readFile(page, '/projects/My Novel/project.json')).toContain('"title": "My Novel"')

  // Formatted text: heading (input rule), bold (Mod-B), bulleted list (toolbar button).
  const ed = editor(page)
  await ed.click()
  await page.keyboard.type('## Chapter One')
  await page.keyboard.press('Enter')
  await page.keyboard.type('It was a ')
  await page.keyboard.press('ControlOrMeta+b')
  await page.keyboard.type('dark')
  await page.keyboard.press('ControlOrMeta+b')
  await page.keyboard.type(' night.')
  await page.keyboard.press('Enter')
  await page.locator('[data-control-id="toolbar.bulletList"]').click()
  await page.keyboard.type('first item')
  await page.keyboard.press('Enter')
  await page.keyboard.type('second item')

  await expect(ed.locator('h2')).toHaveText('Chapter One')
  await expect(ed.locator('strong')).toHaveText('dark')
  // TEMP diagnostics (macOS Chromium typing loss): state vs DOM.
  console.log('[diag]', JSON.stringify(await page.evaluate(() => window.__nvE2E.editorDiag())))
  await expect(ed.locator('ul > li')).toHaveCount(2)
  await expect(saveStatus(page)).toHaveText('My Novel: Unsaved changes')

  // Mod-S saves.
  await page.keyboard.press('ControlOrMeta+s')
  await expect(saveStatus(page)).toHaveText('My Novel: Saved')
  const saved = JSON.parse((await readFile(page, '/projects/My Novel/manuscript.json'))!)
  const types = JSON.stringify(saved)
  expect(types).toContain('"type":"heading"')
  expect(types).toContain('"type":"bold"')
  expect(types).toContain('"type":"bulletList"')
  const before = await editorHTML(page)

  // Relaunch (a fresh app window over the same disk), then File > Open Recent.
  await page.close()
  const relaunched = await context.newPage()
  await launch(relaunched)
  await expect(saveStatus(relaunched)).toHaveText('No project open')
  const menu = await relaunched.evaluate(() => window.__nvE2E.recentMenu() as { path: string; label: string }[])
  expect(menu.map((m) => m.path)).toEqual(['/projects/My Novel'])
  await openRecent(relaunched, '/projects/My Novel')
  await expect(saveStatus(relaunched)).toHaveText('My Novel: All changes saved')
  await expect(editor(relaunched).locator('h2')).toHaveText('Chapter One')
  expect(await editorHTML(relaunched)).toBe(before)
  // No crash-recovery prompt after a clean save.
  await expect(relaunched.getByRole('dialog')).toHaveCount(0)
})

test('Save with no project open asks for a folder and creates the project (Save As)', async ({ page }) => {
  await launch(page)
  await editor(page).click()
  await page.keyboard.type('Draft before any project.')
  await expect(saveStatus(page)).toHaveText('Not saved yet — choose Save as project to keep your work')
  await page.evaluate(() => window.__nvE2E.setNextPick('/projects/Draft'))
  await page.keyboard.press('ControlOrMeta+s')
  await expect(saveStatus(page)).toHaveText('Draft: All changes saved')
  expect(await readFile(page, '/projects/Draft/manuscript.json')).toContain('Draft before any project.')
})

test('first run without the File menu: type, then the in-window "Save as project…" saves', async ({ page }) => {
  await launch(page)
  const statusBar = page.locator('footer[aria-label="Status bar"]')
  await expect(statusBar.getByRole('button', { name: 'New project…' })).toBeVisible()
  await expect(statusBar.getByRole('button', { name: 'Open project…' })).toBeVisible()
  await expect(statusBar.getByRole('button', { name: 'Save as project…' })).toHaveCount(0)

  await editor(page).click()
  await page.keyboard.type('My first words.')
  await expect(saveStatus(page)).toHaveText('Not saved yet — choose Save as project to keep your work')
  await page.evaluate(() => window.__nvE2E.setNextPick('/projects/First'))
  await statusBar.getByRole('button', { name: 'Save as project…' }).click()
  await expect(saveStatus(page)).toHaveText('First: All changes saved')
  expect(await readFile(page, '/projects/First/manuscript.json')).toContain('My first words.')
  // A project is open: the no-project actions are gone.
  await expect(statusBar.getByRole('button', { name: 'New project…' })).toHaveCount(0)
})

test('in-window "Open project…" opens a project folder', async ({ page }) => {
  await launch(page)
  await seedProject(page, '/projects/Shelf', 'Shelf', {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'From the shelf.' }] }],
  })
  await page.evaluate(() => window.__nvE2E.setNextPick('/projects/Shelf'))
  await page.locator('footer').getByRole('button', { name: 'Open project…' }).click()
  await expect(saveStatus(page)).toHaveText('Shelf: All changes saved')
  await expect(editor(page)).toHaveText('From the shelf.')
})
