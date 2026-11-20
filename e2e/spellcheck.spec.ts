import { expect, test, type Page } from '@playwright/test'
import { clickBlockStart, editor, launch, lineEnd, openRecent, saveStatus, seedProject, waitForLayout } from './helpers'

/**
 * Spell check in the paginated manuscript (Phase 5 T5): Harper's findings (the fake engine flags
 * "teh") are underlined once typing pauses; right-click or Shift+F10 opens the Word-style context
 * menu (suggestions first, Ignore Once, Add to Dictionary, then the clipboard); a suggestion replaces
 * the word in one undoable step; View ▸ Spelling & Grammar turns the underlines off.
 */

const p = (t: string) => ({ type: 'paragraph', content: [{ type: 'text', text: t }] })
const DOC = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'One' }] },
    p('“Aelinor’s” horse saw teh river \u{1F600} at dusk.'),
    p('A second paragraph with no mistakes.'),
  ],
}

const underline = (page: Page) => editor(page).locator('.spell-error')
const menu = (page: Page) => page.getByRole('menu', { name: 'Manuscript actions' })
const undo = process.platform === 'darwin' ? 'Meta+z' : 'Control+z'

async function open(page: Page, folder = '/projects/Spell') {
  await page.setViewportSize({ width: 1280, height: 800 })
  await launch(page)
  await seedProject(page, folder, 'Spell', DOC)
  await openRecent(page, folder)
  await expect(saveStatus(page)).toHaveText('Spell: All changes saved')
  await waitForLayout(page)
  await expect(underline(page)).toHaveText(['teh'])
}

test('right-click a misspelling on a page and apply a suggestion (one undo step)', async ({ page }) => {
  await open(page)
  await underline(page).click({ button: 'right' })
  await expect(menu(page)).toBeVisible()
  const items = menu(page).getByRole('menuitem')
  await expect(items).toHaveText(['the', 'Ignore Once', 'Add to Dictionary', 'Ask the Tutor About This', /^Cut/, /^Copy/, /^Paste/])
  await menu(page).getByRole('menuitem', { name: 'the', exact: true }).click()
  await expect(menu(page)).toHaveCount(0)
  const para = editor(page).locator(':scope > p').first()
  await expect(para).toHaveText('“Aelinor’s” horse saw the river \u{1F600} at dusk.')
  await expect(underline(page)).toHaveCount(0)
  await expect(editor(page)).toBeFocused()
  await page.keyboard.press(undo)
  await expect(para).toHaveText('“Aelinor’s” horse saw teh river \u{1F600} at dusk.')
  await expect(underline(page)).toHaveText(['teh'])
})

test('Shift+F10 opens the menu at the caret with the keyboard; Escape returns to the text', async ({ page }) => {
  await open(page)
  // The caret inside "teh" (a click on the word; arrow-key walks land unevenly around the pages).
  await underline(page).click()
  await expect(editor(page)).toBeFocused()
  await page.keyboard.press('Shift+F10')
  await expect(menu(page)).toBeVisible()
  await expect(menu(page).getByRole('menuitem', { name: 'the', exact: true })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(menu(page)).toHaveCount(0)
  await expect(editor(page)).toBeFocused()
})

test('Add to Dictionary clears the word and is kept in preferences; typing a new one is underlined after the pause', async ({ page }) => {
  await open(page)
  await underline(page).click({ button: 'right' })
  await menu(page).getByRole('menuitem', { name: 'Add to Dictionary' }).click()
  await expect(underline(page)).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => window.__nvE2E.preferences().spellcheck.words)).toEqual(['teh'])
  // A different misspelling typed at the end of the second paragraph.
  await page.evaluate(() => window.__nvE2E.spell.misspellings.set('wrod', ['word']))
  await clickBlockStart(page, editor(page).locator(':scope > p').nth(1))
  await lineEnd(page)
  await page.keyboard.type(' A wrod here.')
  await expect(underline(page)).toHaveText(['wrod'])
})

test('View > Spelling & Grammar turns the underlines off and on', async ({ page }) => {
  await open(page)
  expect(await page.evaluate(() => window.__nvE2E.runCommand('view.spellcheck'))).toBe(true)
  await expect(underline(page)).toHaveCount(0)
  expect(await page.evaluate(() => window.__nvE2E.preferences().spellcheck.enabled)).toBe(false)
  expect(await page.evaluate(() => window.__nvE2E.runCommand('view.spellcheck'))).toBe(true)
  await expect(underline(page)).toHaveText(['teh'])
})
