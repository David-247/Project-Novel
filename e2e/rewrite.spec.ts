import { expect, test, type Locator, type Page } from '@playwright/test'
import { editor, launch, newProject, openRecent, recoveryControl, saveStatus, waitForLayout } from './helpers'

/**
 * Re-write (Phase 3): original and revision side by side. Opening on a selection (whole paragraphs),
 * the book's typesetting on both pages, paragraph alignment while typing, live word differences, the
 * locked passage in the manuscript, versions (create, rename, switch by keyboard and pointer), Flip
 * and the focus keys, drafts kept on close, save / reopen / crash recovery, narrow windows, tooltips.
 */

const ctl = (scope: Page | Locator, id: string) => scope.locator(`[data-control-id="${id}"]`)
const view = (page: Page) => page.getByTestId('rewrite-view')
const original = (page: Page) => page.getByTestId('rewrite-original')
const revision = (page: Page) => page.getByRole('textbox', { name: 'Revised passage' })
const rw = (page: Page) => page.evaluate(() => window.__nvE2E.rewrite())

const p = (t: string) => ({ type: 'paragraph', content: [{ type: 'text', text: t }] })
const h = (t: string) => ({ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: t }] })
const DOC = {
  type: 'doc',
  content: [
    h('The Storm'),
    p('The rain came at dusk, soft at first and then hard against the shutters.'),
    p('She closed the window and listened to the house settle around her.'),
    p('Nobody spoke for a long time.'),
    p('In the morning the river had risen to the garden wall.'),
    h('The Flood'),
    p('Water everywhere.'),
  ],
}

async function project(page: Page, name: string) {
  await launch(page)
  await newProject(page, `/projects/${name}`)
  await page.evaluate((d) => window.__nvE2E.setDoc(d), DOC)
  await waitForLayout(page)
}

/** Select from inside block `a` to inside block `b` in the manuscript, then Re-write Passage… (Mod-Alt-r). */
async function openOn(page: Page, a: number, b: number) {
  await editor(page).click()
  await page.evaluate(async ([x, y]) => {
    const e = window.__nvE2E
    e.selectText(e.blockPos(x) + 3, e.blockPos(y) + 3)
  }, [a, b] as const)
  await page.keyboard.press('ControlOrMeta+Alt+r')
  await expect(view(page)).toBeVisible()
  await expect(revision(page)).toBeFocused()
}

/** Where the text of the n-th top-level block of a page starts (px, viewport): its top plus the alignment pad. */
const blockTop = (page: Locator, n: number) =>
  page.evaluate((el, i) => {
    const b = el.children[i] as HTMLElement
    return b.getBoundingClientRect().top + parseFloat(getComputedStyle(b).paddingTop)
  }, n)

test('open a re-write on a selection: book typesetting, aligned paragraphs, live differences, locked original', async ({ page }) => {
  await project(page, 'Rewrite')
  await openOn(page, 1, 3)
  await expect(page.getByRole('region', { name: 'Original' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Revised version 1' })).toBeVisible()
  // Whole paragraphs 1-3, nothing else.
  await expect(original(page).locator('p')).toHaveCount(3)
  await expect(revision(page).locator('p')).toHaveCount(3)
  await expect(original(page).locator('p').first()).toHaveText(DOC.content[1].content[0].text)

  // Typeset like the book: same style rules and text width as the manuscript's pages.
  const style = await page.evaluate(() => {
    const pick = (el: Element) => {
      const cs = getComputedStyle(el)
      return { font: cs.fontFamily, size: cs.fontSize, line: cs.lineHeight, indent: cs.textIndent }
    }
    const manuscript = document.querySelectorAll('main .nv-text-layer .novel-editor-content > p')[2]
    const orig = document.querySelectorAll('[data-testid="rewrite-original"] > p')[1]
    const rev = document.querySelectorAll('[data-testid="rewrite-revision"] > p')[1]
    // Layout width (the manuscript's pages are scaled by the zoom transform; this view is at 100 %).
    const width = (el: Element) => (el as HTMLElement).offsetWidth
    return {
      manuscript: pick(manuscript),
      orig: pick(orig),
      rev: pick(rev),
      widths: [width(document.querySelector('main .nv-text-layer .novel-editor-content > p')!), width(orig), width(rev)],
      paper: [getComputedStyle(document.querySelector('[aria-label="Original"]')!).backgroundColor, getComputedStyle(document.documentElement).getPropertyValue('--page-bg')],
    }
  })
  expect(style.orig).toEqual(style.manuscript)
  expect(style.rev).toEqual(style.manuscript)
  expect(Math.abs(style.widths[1] - style.widths[0])).toBeLessThan(1)
  expect(Math.abs(style.widths[2] - style.widths[0])).toBeLessThan(1)

  // Type into the revision: a new first paragraph, then words added to the last one.
  const rev = revision(page)
  await page.keyboard.press('ControlOrMeta+Home')
  await page.keyboard.type('A thunderclap shook every pane of glass in the old house.')
  await page.keyboard.press('Enter')
  await expect(rev.locator('p')).toHaveCount(4)
  await expect.poll(async () => (await rw(page)).debug.rows).toEqual(['added', 'same', 'same', 'same'])
  // Paragraph N of the original stays level with its counterpart (a gap opposite the new paragraph).
  for (const [l, r] of [
    [0, 1],
    [1, 2],
    [2, 3],
  ]) {
    await expect.poll(async () => Math.abs((await blockTop(original(page), l)) - (await blockTop(rev, r)))).toBeLessThan(1.5)
  }
  // Live differences: the added paragraph, and edited words.
  await expect(rev.locator('.nv-rw-ins-block')).toHaveText('A thunderclap shook every pane of glass in the old house.')
  await rev.locator('p').nth(3).click()
  await page.keyboard.press('End')
  await page.keyboard.type(' Slowly.')
  await expect(rev.locator('.nv-rw-ins')).toHaveText('Slowly.')
  await expect(page.getByTestId('rewrite-spine').locator('[data-kind="changed"]')).toHaveCount(1)
  // Alignment still holds while scrolling: one scroller holds both pages.
  await page.locator('.nv-rw-scroller').evaluate((el) => el.scrollBy(0, 40))
  expect(Math.abs((await blockTop(original(page), 2)) - (await blockTop(rev, 3)))).toBeLessThan(1.5)

  // Show differences off and on (button and Mod-Shift-d).
  await ctl(page, 'rewrite.showDiff').click()
  await expect(rev.locator('.nv-rw-ins, .nv-rw-ins-block')).toHaveCount(0)
  await page.keyboard.press('ControlOrMeta+Shift+d')
  await expect(rev.locator('.nv-rw-ins')).toHaveText('Slowly.')

  // Every control in the view has a tooltip.
  expect(await page.evaluate(() => window.__nvE2E.auditTooltips())).toEqual([])

  // Close (Escape): the manuscript again, the passage marked and read-only.
  await rev.click()
  await page.keyboard.press('Escape')
  await expect(view(page)).toHaveCount(0)
  await expect(editor(page)).toBeFocused()
  const locked = editor(page).locator('.nv-rw-locked')
  await expect(locked).toHaveCount(3)
  const before = await page.evaluate(() => window.__nvE2E.docJSON())
  await page.evaluate(() => window.__nvE2E.selectText(window.__nvE2E.blockPos(2) + 4, window.__nvE2E.blockPos(2) + 4))
  await page.keyboard.type('xyz')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Backspace')
  expect(await page.evaluate(() => window.__nvE2E.docJSON())).toEqual(before)
  const notice = page.getByTestId('rewrite-notice')
  await expect(notice).toBeVisible()
  await expect(notice).toContainText('being re-written')
  expect(await page.evaluate(() => window.__nvE2E.auditTooltips())).toEqual([])
  // Text outside the passage stays editable.
  await page.evaluate(() => window.__nvE2E.selectText(window.__nvE2E.blockPos(4) + 1, window.__nvE2E.blockPos(4) + 1))
  await page.keyboard.type('Then. ')
  await expect(editor(page).locator('p').nth(3)).toHaveText(/^Then\. In the morning/)

  // The draft was kept: the notice reopens it with the typed text.
  await page.evaluate(() => window.__nvE2E.selectText(window.__nvE2E.blockPos(1) + 2, window.__nvE2E.blockPos(1) + 2))
  await ctl(notice, 'rewrite.noticeOpen').click()
  await expect(revision(page).locator('p')).toHaveCount(4)
  await expect(revision(page).locator('p').nth(3)).toContainText('Slowly.')
})

test('several versions: create, rename, switch by keyboard and pointer; focus keys and Flip', async ({ page }) => {
  await project(page, 'Versions')
  await openOn(page, 2, 2)
  await page.keyboard.type('First take. ')
  await ctl(page, 'rewrite.newVersion').click()
  const tabs = page.getByRole('tab')
  await expect(tabs).toHaveText(['Version 1', 'Version 2'])
  await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('region', { name: 'Revised version 2' })).toBeVisible()
  // A copy of the version it was made from.
  await expect(revision(page)).toContainText('First take.')
  await revision(page).click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.type('A completely different second version.')

  // Rename: the pen button, type, Enter.
  await ctl(page, 'rewrite.rename').click()
  const field = ctl(page, 'rewrite.renameField')
  await expect(field).toBeFocused()
  await field.fill('Darker')
  await page.keyboard.press('Enter')
  await expect(tabs).toHaveText(['Version 1', 'Darker'])

  // Keyboard: the tabs move with the arrow keys; pointer: a click.
  await tabs.nth(1).focus()
  await page.keyboard.press('ArrowLeft')
  await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true')
  await expect(revision(page)).toContainText('First take.')
  await tabs.nth(1).click()
  await expect(revision(page)).toHaveText('A completely different second version.')
  // Undo is local to the version (and kept per version while the view is open).
  await revision(page).click()
  await page.keyboard.press('ControlOrMeta+z')
  await expect(revision(page)).not.toHaveText('A completely different second version.')
  await page.keyboard.press('ControlOrMeta+Shift+z')
  await expect(revision(page)).toHaveText('A completely different second version.')

  // Mod-Alt-Left / Right: the original (left) and the revision (right).
  await page.keyboard.press('ControlOrMeta+Alt+ArrowLeft')
  await expect(original(page)).toBeFocused()
  await page.keyboard.press('ControlOrMeta+Alt+ArrowRight')
  await expect(revision(page)).toBeFocused()
  // Flip: the revision moves to the left page; the keys follow the pages.
  const x = async (side: string) => (await page.locator(`[data-side="${side}"]`).boundingBox())!.x
  expect(await x('original')).toBeLessThan(await x('revised'))
  await ctl(page, 'rewrite.flip').click()
  expect(await x('revised')).toBeLessThan(await x('original'))
  await page.keyboard.press('ControlOrMeta+Alt+ArrowLeft')
  await expect(revision(page)).toBeFocused()
  await page.keyboard.press('ControlOrMeta+Alt+k')
  expect(await x('original')).toBeLessThan(await x('revised'))
  expect(await page.evaluate(() => window.__nvE2E.auditTooltips())).toEqual([])
})

test('a selection over two chapters is refused; Phase 2 projects open without rewrites.json', async ({ page }) => {
  await project(page, 'Span')
  await editor(page).click()
  await page.evaluate(() => window.__nvE2E.selectText(window.__nvE2E.blockPos(3) + 2, window.__nvE2E.blockPos(6) + 2))
  await page.keyboard.press('ControlOrMeta+Alt+r')
  await expect(page.getByTestId('rewrite-notice')).toContainText('one chapter at most')
  await expect(view(page)).toHaveCount(0)
  expect((await rw(page)).rewrites).toHaveLength(0)
  await editor(page).press('ControlOrMeta+s')
  await expect(saveStatus(page)).toHaveText('Span: Saved')
  expect(await page.evaluate(() => window.__nvE2E.readFile('/projects/Span/rewrites.json'))).toBeNull()
})

test('drafts survive save and reopen, and crash recovery', async ({ page, context }) => {
  await page.clock.install()
  await project(page, 'Kept')
  await openOn(page, 1, 2)
  await page.keyboard.type('Saved words. ')
  await ctl(page, 'rewrite.newVersion').click()
  await page.keyboard.press('ControlOrMeta+s')
  await expect(saveStatus(page)).toHaveText('Kept: Saved')
  const saved = JSON.parse((await page.evaluate(() => window.__nvE2E.readFile('/projects/Kept/rewrites.json')))!)
  expect(saved).toMatchObject({ version: 1, rewrites: [{ status: 'open', versions: [{ name: 'Version 1' }, { name: 'Version 2' }] }] })
  expect(saved.rewrites[0].versions[0].doc.content[0].content[0].text).toMatch(/^Saved words\. The rain/)
  const manuscript = (await page.evaluate(() => window.__nvE2E.readFile('/projects/Kept/manuscript.json')))!
  expect(manuscript.match(/"rewriteId":"rw-/g)).toHaveLength(2)

  // Unsaved typing in the revision, backed up by autosave, then a crash.
  await revision(page).click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.type(' Unsaved tail.')
  await expect(saveStatus(page)).toContainText('Unsaved changes')
  await page.clock.runFor(31_000)
  await expect(saveStatus(page)).toHaveText(/^Kept: Unsaved changes · backed up \d/)
  await page.close({ runBeforeUnload: false })

  const relaunched = await context.newPage()
  await launch(relaunched)
  await recoveryControl(relaunched, 'reopen').click()
  await expect(relaunched.getByRole('dialog', { name: 'Restore unsaved changes?' })).toBeVisible()
  await recoveryControl(relaunched, 'restore').click()
  await expect(editor(relaunched).locator('.nv-rw-locked')).toHaveCount(2)
  const restored = await rw(relaunched)
  expect(restored.rewrites[0].versions).toHaveLength(2)
  expect(JSON.stringify(restored.rewrites[0].versions[1].doc)).toContain('Unsaved tail.')
  // Reopen it from Review ▸ Next Re-write: both versions, the last one viewed.
  await relaunched.evaluate(() => window.__nvE2E.runCommand('rewrite.next'))
  await expect(relaunched.getByRole('tab')).toHaveText(['Version 1', 'Version 2'])
  await expect(revision(relaunched)).toContainText('Unsaved tail.')
  await relaunched.keyboard.press('ControlOrMeta+s')
  await expect(saveStatus(relaunched)).toHaveText('Kept: Saved')

  // A plain reopen (no crash).
  await relaunched.close({ runBeforeUnload: false })
  const third = await context.newPage()
  await launch(third)
  await openRecent(third, '/projects/Kept')
  await expect(saveStatus(third)).toHaveText('Kept: All changes saved')
  await waitForLayout(third)
  await third.evaluate(() => window.__nvE2E.runCommand('rewrite.list'))
  const list = third.getByRole('dialog', { name: 'Re-writes' })
  await expect(list.getByTestId('rewrite-list').locator('li')).toHaveCount(1)
  expect(await third.evaluate(() => window.__nvE2E.auditTooltips())).toEqual([])
  await ctl(list, 'rewrite.listItem').click()
  await expect(revision(third)).toContainText('Unsaved tail.')
})

test('narrow window: one page at a time with a toggle', async ({ page }) => {
  await page.setViewportSize({ width: 760, height: 800 })
  await project(page, 'Narrow')
  await openOn(page, 1, 1)
  await expect(ctl(page, 'rewrite.showRevised')).toHaveAttribute('aria-pressed', 'true')
  await expect(revision(page)).toBeVisible()
  await expect(original(page)).toBeHidden()
  await ctl(page, 'rewrite.showOriginal').click()
  await expect(original(page)).toBeVisible()
  await expect(revision(page)).toBeHidden()
  // The focus key brings the revision back.
  await page.keyboard.press('ControlOrMeta+Alt+ArrowRight')
  await expect(revision(page)).toBeVisible()
  await expect(revision(page)).toBeFocused()
  expect(await page.evaluate(() => window.__nvE2E.auditTooltips())).toEqual([])
})
