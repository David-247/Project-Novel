import { expect, test, type Page } from '@playwright/test'
import { editor, editorHTML, launch, newProject, readFile, saveStatus } from './helpers'

/**
 * The in-app menu bar (Windows, and every e2e engine), rendered from the command registry. The native
 * macOS menu is the same registry's snapshot (checked at the end through the fake backend).
 */

const bar = (page: Page) => page.getByRole('menubar', { name: 'Menu bar' })
const title = (page: Page, menu: string) => bar(page).locator(`[data-control-id="menu.${menu}"]`)
const item = (page: Page, id: string) => page.locator(`[role="menu"] [data-control-id="${id}"]`)
const selectedText = (page: Page) => page.evaluate(() => window.getSelection()?.toString() ?? '')

/** Pointer: open `menu` and choose `id` (opening `submenu` titles on the way). */
async function choose(page: Page, menu: string, id: string, submenus: string[] = []) {
  await title(page, menu).click()
  for (const s of submenus) await item(page, s).click()
  await item(page, id).click()
  await expect(page.getByRole('menu')).toHaveCount(0)
}

/** Select the last `n` characters before the caret with Shift+Left. */
async function selectBack(page: Page, n: number) {
  for (let i = 0; i < n; i++) await page.keyboard.press('Shift+ArrowLeft')
}

test('menu bar keyboard: Alt and F10 focus File, arrows move, Escape returns to the editor with its selection', async ({ page }) => {
  await launch(page)
  await editor(page).click()
  await page.keyboard.type('Hello world')
  await selectBack(page, 5)
  await expect.poll(() => selectedText(page)).toBe('world')

  await page.keyboard.press('F10')
  await expect(title(page, 'file')).toBeFocused()
  await page.keyboard.press('ArrowRight')
  await expect(title(page, 'edit')).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(page.getByRole('menu')).toBeVisible()
  // Undo is the first item; arrows move through the items, skipping disabled ones (Redo: nothing undone).
  await expect(item(page, 'history.undo')).toBeFocused()
  await expect(item(page, 'history.redo')).toHaveAttribute('aria-disabled', 'true')
  await page.keyboard.press('ArrowDown')
  await expect(item(page, 'edit.cut')).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(editor(page)).toBeFocused()
  await expect.poll(() => selectedText(page)).toBe('world')

  // Alt alone does the same; Escape on a closed menu title goes back too.
  await page.keyboard.press('Alt')
  await expect(title(page, 'file')).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(editor(page)).toBeFocused()
  await expect.poll(() => selectedText(page)).toBe('world')

  // Keyboard choice: the command runs on the restored selection.
  await page.keyboard.press('F10')
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowRight') // File -> Format
  await expect(title(page, 'format')).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(item(page, 'toolbar.italic')).toBeVisible()
  await item(page, 'toolbar.italic').focus()
  await page.keyboard.press('Enter')
  await expect(editor(page).locator('em')).toHaveText('world')
  await expect(editor(page)).toBeFocused()
  await expect.poll(() => selectedText(page)).toBe('world')
})

test('Format and Insert from the menu act on the editor and keep the selection', async ({ page }) => {
  await launch(page)
  await editor(page).click()
  await page.keyboard.type('Hello world')
  await selectBack(page, 5)

  await choose(page, 'format', 'toolbar.bold')
  await expect(editor(page).locator('strong')).toHaveText('world')
  await expect(editor(page)).toBeFocused()
  await expect.poll(() => selectedText(page)).toBe('world')

  // Checked state is live: Bold shows checked in bold text.
  await title(page, 'format').click()
  await expect(item(page, 'toolbar.bold')).toHaveAttribute('aria-checked', 'true')
  await page.keyboard.press('Escape')
  await expect.poll(() => selectedText(page)).toBe('world')

  // Alignment submenu.
  await choose(page, 'format', 'toolbar.alignCenter', ['menu.format.alignment'])
  await expect(editor(page).locator('p').first()).toHaveCSS('text-align', 'center')
  await expect.poll(() => selectedText(page)).toBe('world')

  // Insert at the caret: a scene break after the paragraph, typing goes on in the editor.
  await page.keyboard.press('End')
  await choose(page, 'insert', 'insert.sceneBreak')
  await expect(editor(page).locator('[data-scene-break]')).toHaveCount(1)
  await expect(editor(page)).toBeFocused()
  await page.keyboard.type('Next scene')
  await expect(editor(page)).toContainText('Next scene')
})

test('Help > Keyboard Shortcuts lists every registry shortcut and filters by search', async ({ page }) => {
  await launch(page)
  await editor(page).click()
  await choose(page, 'help', 'help.shortcuts')
  const dialog = page.getByRole('dialog', { name: 'Keyboard Shortcuts' })
  await expect(dialog).toBeVisible()
  const rows = await page.evaluate(() => window.__nvE2E.shortcutRows())
  expect(rows.length).toBeGreaterThan(20)
  for (const r of rows) {
    await expect(dialog.locator(`[data-command-id="${r.id}"] [data-testid="shortcut-keys"]`), r.id).toHaveText(r.keys)
  }
  // The menu shows the same keys as the sheet.
  await page.getByRole('searchbox', { name: 'Search shortcuts' }).fill('bold')
  await expect(dialog.locator('[data-command-id]')).toHaveCount(1)
  await expect(dialog.locator('[data-command-id="toolbar.bold"]')).toBeVisible()
  expect(await page.evaluate(() => window.__nvE2E.auditTooltips())).toEqual([])
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(editor(page)).toBeFocused()

  // The shortcut opens it too.
  await page.keyboard.press('ControlOrMeta+/')
  await expect(page.getByRole('dialog', { name: 'Keyboard Shortcuts' })).toBeVisible()
})

test('File > Save a Copy writes a project folder that opens identically', async ({ page }) => {
  await launch(page)
  await newProject(page, '/projects/Original')
  await editor(page).click()
  await page.keyboard.type('Chapter text that must survive the copy.')
  await page.keyboard.press('ControlOrMeta+b')
  await page.keyboard.type(' Bold too.')
  const before = await editorHTML(page)

  await page.evaluate(() => window.__nvE2E.setNextPick('/projects/Copy'))
  await choose(page, 'file', 'file.save_copy')
  await expect.poll(() => readFile(page, '/projects/Copy/project.json')).not.toBeNull()
  expect(await readFile(page, '/projects/Copy/manuscript.json')).toContain('Bold too.')
  // Still working in the original, with its changes unsaved.
  await expect(saveStatus(page)).toHaveText('Original: Unsaved changes')

  await page.keyboard.press('ControlOrMeta+s')
  await expect(saveStatus(page)).toContainText('Original: Saved')
  await page.evaluate(() => window.__nvE2E.setNextPick('/projects/Copy'))
  await choose(page, 'file', 'file.open_project')
  await expect(saveStatus(page)).toContainText('Original:') // the copy keeps the title
  expect(await editorHTML(page)).toBe(before)
})

test('every menu and submenu item has a wired tooltip (coverage audit)', async ({ page }) => {
  await launch(page)
  await editor(page).click()
  const menus = ['file', 'edit', 'view', 'insert', 'format', 'help']
  await expect(bar(page).locator('[data-control-id^="menu."]')).toHaveCount(menus.length)
  let seen = 0
  for (const m of menus) {
    await title(page, m).click()
    const menu = page.getByRole('menu').first()
    await expect(menu).toBeVisible()
    seen += await menu.locator('[data-control-id]').count()
    expect(await page.evaluate(() => window.__nvE2E.auditTooltips()), `menu ${m}`).toEqual([])
    const subs = await menu.locator('[aria-haspopup="menu"]').all()
    for (const sub of subs) {
      await sub.focus()
      await sub.press('ArrowRight')
      await expect(page.getByRole('menu')).toHaveCount(2)
      seen += await page.getByRole('menu').nth(1).locator('[data-control-id]').count()
      expect(await page.evaluate(() => window.__nvE2E.auditTooltips()), `submenu of ${m}`).toEqual([])
      await page.keyboard.press('ArrowLeft')
      await expect(page.getByRole('menu')).toHaveCount(1)
    }
    await page.keyboard.press('Escape')
    await expect(page.getByRole('menu')).toHaveCount(0)
  }
  expect(seen).toBeGreaterThan(60)

  // Hover shows the item's copy (from the tooltips registry, or from its command).
  await title(page, 'file').click()
  await item(page, 'file.save_copy').hover()
  await expect(page.locator('[data-tooltip-body]')).toContainText('Write a copy of the project to another folder')
})

test('the native menu is the same registry: snapshot, and menu://command runs the command', async ({ page }) => {
  await launch(page)
  await editor(page).click()
  await page.keyboard.type('Native')
  await page.keyboard.press('ControlOrMeta+a')
  type Node = { kind: string; id?: string; label?: string; accelerator?: string; checked?: boolean; items?: Node[] }
  const snapshot = async () => (await page.evaluate(() => window.__nvE2E.nativeMenu())) as { menus: { id: string; items: Node[] }[] } | null
  await expect.poll(async () => (await snapshot())?.menus.map((m) => m.id)).toEqual(['app', 'file', 'edit', 'view', 'insert', 'format', 'help'])
  const flat = (nodes: Node[]): Node[] => nodes.flatMap((n) => (n.items ? flat(n.items) : [n]))
  const format = (await snapshot())!.menus.find((m) => m.id === 'format')!
  expect(flat(format.items).find((n) => n.id === 'toolbar.bold')).toMatchObject({ accelerator: 'CmdOrCtrl+B', checked: false })
  // macOS Edit uses the OS clipboard items.
  const edit = (await snapshot())!.menus.find((m) => m.id === 'edit')!
  expect(edit.items.filter((n) => n.kind === 'predefined').map((n) => (n as { name?: string }).name)).toEqual(['cut', 'copy', 'paste', 'selectAll'])

  await page.evaluate(() => window.__nvE2E.emit('menu://command', 'toolbar.bold'))
  await expect(editor(page).locator('strong')).toHaveText('Native')
  // Live checked state reaches the snapshot (debounced).
  await expect
    .poll(async () => flat((await snapshot())!.menus.find((m) => m.id === 'format')!.items).find((n) => n.id === 'toolbar.bold')?.checked)
    .toBe(true)
})
