import { expect, test, type Page } from '@playwright/test'
import { editor, launch, newProject, recoveryControl, seedProject, writeFile } from './helpers'

const tip = (page: Page) => page.locator('[data-tooltip-body]')

/** Move the pointer away into the writing area (several steps, so hover-out is seen). */
async function pointerAway(page: Page) {
  const box = (await page.getByRole('main', { name: 'Editor' }).boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height - 20, { steps: 8 })
}

/** auditTooltipCoverage in the page: every visible control must have a wired tooltip. */
async function expectFullCoverage(page: Page, minControls: number) {
  expect(await page.evaluate(() => window.__nvE2E.countControls())).toBeGreaterThanOrEqual(minControls)
  expect(await page.evaluate(() => window.__nvE2E.auditTooltips())).toEqual([])
}

// A sample across slices: formatting toolbar, selects, history, find button and find panel controls.
const HOVER_SAMPLE = [
  ['toolbar.bold', 'Bold'],
  ['toolbar.fontFamily', 'Font'],
  ['toolbar.alignCenter', 'Align center'],
  ['toolbar.indentIncrease', 'Increase indent'],
  ['history.redo', 'Redo'],
  ['find.open', 'Find'],
] as const

test('tooltips on hover and on keyboard focus for a sample of controls; coverage audit passes', async ({ page }) => {
  await launch(page)
  await newProject(page, '/projects/Tips')
  await editor(page).click()
  await page.keyboard.type('Some text to find.')
  await expectFullCoverage(page, 19)

  for (const [id, text] of HOVER_SAMPLE) {
    await pointerAway(page)
    await expect(tip(page)).toHaveCount(0)
    await page.locator(`[data-control-id="${id}"]`).hover()
    await expect(tip(page), `hover tooltip for ${id}`).toContainText(text)
  }
  await pointerAway(page)

  // Keyboard focus (roving arrows inside the toolbar) shows the tooltip of each focused control.
  await page.locator('[data-control-id="toolbar.alignLeft"]').focus()
  for (const [id, text] of [
    ['toolbar.alignCenter', 'Center each line of the paragraph.'],
    ['toolbar.alignRight', 'Align right'],
  ]) {
    await page.keyboard.press('ArrowRight')
    await expect(page.locator(`[data-control-id="${id}"]`)).toBeFocused()
    await expect(tip(page), `focus tooltip for ${id}`).toContainText(text)
  }
  await page.keyboard.press('Escape')
  await expect(tip(page)).toHaveCount(0)

  // The find panel adds its own controls.
  await editor(page).click()
  await page.keyboard.press('ControlOrMeta+f')
  await expect(page.getByRole('region', { name: 'Find and replace' })).toBeVisible()
  await expectFullCoverage(page, 19 + 8)
})

test('no project open: the in-window project actions have tooltips and pass the audit', async ({ page }) => {
  await launch(page)
  await expectFullCoverage(page, 19 + 2)
  await page.locator('[data-control-id="file.new_project"]').hover()
  await expect(tip(page)).toContainText('Start a new project folder for a manuscript.')
  await pointerAway(page)
  await editor(page).click()
  await page.keyboard.type('Unsaved words.')
  await expectFullCoverage(page, 19 + 3)
  await page.locator('[data-control-id="file.new_project"]').focus()
  await page.keyboard.press('Shift+Tab')
  await expect(page.locator('[data-control-id="file.save"]')).toBeFocused()
  await expect(tip(page)).toContainText('With no project open, choose a folder.')
})

test('recovery dialog controls have tooltips (hover + focus) and pass the audit', async ({ page }) => {
  await launch(page)
  const doc = (t: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }] })
  await seedProject(page, '/projects/Backup', 'Backup', doc('saved'))
  const meta = JSON.parse((await page.evaluate(() => window.__nvE2E.readFile('/projects/Backup/project.json')))!)
  await writeFile(
    page,
    '/projects/Backup/.recovery/manuscript.json',
    JSON.stringify({
      format: 'novel-recovery',
      version: 1,
      projectId: meta.id,
      savedAt: new Date().toISOString(),
      baseUpdatedAt: meta.updatedAt,
      docVersion: 3,
      doc: doc('saved and more'),
    }),
  )
  // A relaunch finds the backup of the last project and asks first.
  await launch(page)
  await expect(page.getByRole('dialog', { name: 'Recover unsaved work?' })).toBeVisible()
  await expectFullCoverage(page, 3)
  await recoveryControl(page, 'reopen').hover()
  await expect(tip(page)).toBeVisible()

  await recoveryControl(page, 'reopen').click()
  await expect(page.getByRole('dialog', { name: 'Restore unsaved changes?' })).toBeVisible()
  await expectFullCoverage(page, 3)
  await recoveryControl(page, 'restore').focus()
  await page.keyboard.press('Shift+Tab')
  await expect(recoveryControl(page, 'discard')).toBeFocused()
  await expect(tip(page)).toBeVisible()
  await recoveryControl(page, 'restore').click()
  await expect(editor(page)).toHaveText('saved and more')
})
