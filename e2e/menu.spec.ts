import { expect, test, type Page } from '@playwright/test'
import { contrastRatio } from '../src/shared/theme/contrast'
import { editor, editorHTML, launch, newProject, readFile, saveStatus, reveal } from './helpers'

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
  await expect(title(page, 'file')).toBeFocused()
  // Radix moves focus on a timer: wait for each step like a human would.
  for (const m of ['edit', 'view', 'insert', 'format']) {
    await page.keyboard.press('ArrowRight')
    await expect(title(page, m)).toBeFocused()
  }
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
  const menus = ['file', 'edit', 'view', 'insert', 'format', 'review', 'help']
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
  await expect.poll(async () => (await snapshot())?.menus.map((m) => m.id)).toEqual(['app', 'file', 'edit', 'view', 'insert', 'format', 'review', 'window', 'help'])
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
  // The macOS Window menu: OS Minimize and Close Window (which runs the close guard).
  const win = (await snapshot())!.menus.find((m) => m.id === 'window')!
  expect(win.items.filter((n) => n.kind === 'predefined').map((n) => (n as { name?: string }).name)).toEqual(['minimize', 'closeWindow'])

  // Full Screen: the check mark follows the window's real state.
  const fullScreenChecked = async () => flat((await snapshot())!.menus.find((m) => m.id === 'view')!.items).find((n) => n.id === 'view.fullScreen')?.checked
  await page.evaluate(() => window.__nvE2E.emit('menu://command', 'view.fullScreen'))
  await expect.poll(() => page.evaluate(() => window.__nvE2E.fullscreen())).toBe(true)
  await expect.poll(fullScreenChecked).toBe(true)
  await page.evaluate(() => window.__nvE2E.emit('menu://command', 'view.fullScreen'))
  await expect.poll(fullScreenChecked).toBe(false)

  // A native Format item while another text field has focus does not touch the manuscript.
  await page.keyboard.press('ControlOrMeta+f')
  await expect(page.getByRole('textbox', { name: 'Find', exact: true })).toBeFocused()
  await page.evaluate(() => window.__nvE2E.emit('menu://command', 'toolbar.italic'))
  await page.evaluate(() => new Promise((r) => setTimeout(r, 100)))
  await expect(editor(page).locator('em')).toHaveCount(0)
})

test('Format > Font lists the picker fonts; Book Details needs a project; F10 stays out of a modal', async ({ page }) => {
  await launch(page)
  await editor(page).click()
  await page.keyboard.type('Typeface')
  await selectBack(page, 8)
  await choose(page, 'format', 'format.fontFamily.E2E Serif', ['menu.format.font'])
  await expect(editor(page).locator('span[style*="E2E Serif"]')).toHaveText('Typeface')
  await expect.poll(() => selectedText(page)).toBe('Typeface')
  await title(page, 'format').click()
  await item(page, 'menu.format.font').click()
  await expect(item(page, 'format.fontFamily.E2E Serif')).toHaveAttribute('aria-checked', 'true')
  await expect(item(page, 'format.fontFamily.system-default')).toHaveAttribute('aria-checked', 'false')
  await expect(item(page, 'format.fontFamily.E2E Sans')).toBeVisible()
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toHaveCount(0)

  // No project open: Book Details (title and author in project.json) is disabled.
  await title(page, 'file').click()
  await expect(item(page, 'book.details')).toHaveAttribute('aria-disabled', 'true')
  await page.keyboard.press('Escape')

  // Behind a modal dialog, F10 and Alt do not reach the menu bar.
  await choose(page, 'help', 'help.about')
  const about = page.getByRole('dialog', { name: 'About Novel' })
  await expect(about).toBeVisible()
  await expect(about.getByTestId('about-version')).toHaveText('0.1.0')
  await page.keyboard.press('F10')
  await page.keyboard.press('Alt')
  // (CSS locator: the modal hides the menu bar from the accessibility tree.)
  await expect(page.locator('[data-nv-menubar] [data-control-id="menu.file"]')).not.toBeFocused()
  await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(true)
  await expect(about).toBeVisible()
})

test('menu bar text meets WCAG AA in every state, on the four papers in light and dark', async ({ page }) => {
  test.setTimeout(120_000)
  await launch(page)
  await editor(page).click()
  await page.keyboard.type('Contrast')
  /** Text colour composited on its effective background, as #rrggbb pairs. */
  const sample = (selector: string) =>
    page.locator(selector).first().evaluate((el) => {
      const parse = (c: string) => {
        const p = (c.match(/rgba?\(([^)]+)\)/)?.[1] ?? '0,0,0,0').split(/[ ,/]+/).filter(Boolean).map(Number)
        return [p[0], p[1], p[2], p[3] ?? 1]
      }
      const over = (top: number[], under: number[]) => [0, 1, 2].map((i) => top[i] * top[3] + under[i] * (1 - top[3]))
      const layers: number[][] = []
      for (let n: Element | null = el; n; n = n.parentElement) {
        const c = parse(getComputedStyle(n).backgroundColor)
        if (c[3] > 0) {
          layers.push(c)
          if (c[3] >= 1) break
        }
      }
      let bg = [255, 255, 255]
      for (const l of layers.reverse()) bg = over(l, bg)
      const fg = over(parse(getComputedStyle(el).color), bg)
      const hex = (rgb: number[]) => '#' + rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')
      return { fg: hex(fg), bg: hex(bg) }
    })
  const failures: string[] = []
  let checked = 0
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    await expect(page.locator('html')).toHaveAttribute('data-theme', scheme)
    for (const surface of ['auto', 'book', 'white', 'dark']) {
      await (await reveal(page, `book.surface.${surface}`)).click()
      // Off the swatch: its tooltip (just under the menu bar since the ribbon) would cover the Edit menu.
      await page.mouse.move(700, 600)
      await expect(page.locator('[data-tooltip-body]')).toHaveCount(0)
      await title(page, 'edit').click()
      // Highlight Undo (the first item) from the keyboard: Radix sets data-highlighted on keyboard
      // focus, which a hover does not do reliably under full-suite load (WebKit on Windows).
      await page.keyboard.press('ArrowDown')
      await expect(item(page, 'history.undo')).toHaveAttribute('data-highlighted', '')
      await page.evaluate(() => new Promise((r) => setTimeout(r, 350)))
      const states: [string, string][] = [
        ['title (closed)', '[data-control-id="menu.file"]'],
        ['title (open)', '[data-control-id="menu.edit"]'],
        ['item', '[role="menu"] [data-control-id="edit.cut"] [data-part="label"]'],
        ['shortcut', '[role="menu"] [data-control-id="edit.cut"] [data-part="shortcut"]'],
        ['highlighted item', '[role="menu"] [data-control-id="history.undo"] [data-part="label"]'],
        ['highlighted shortcut', '[role="menu"] [data-control-id="history.undo"] [data-part="shortcut"]'],
        ['disabled item', '[role="menu"] [data-control-id="history.redo"] [data-part="label"]'],
        ['disabled shortcut', '[role="menu"] [data-control-id="history.redo"] [data-part="shortcut"]'],
      ]
      for (const [what, sel] of states) {
        const { fg, bg } = await sample(sel)
        const ratio = contrastRatio(fg, bg)
        checked++
        if (ratio < 4.5) failures.push(`${scheme}/${surface} ${what}: ${ratio.toFixed(2)}:1 (${fg} on ${bg})`)
      }
      await page.keyboard.press('Escape')
      await expect(page.getByRole('menu')).toHaveCount(0)
    }
  }
  expect(checked).toBe(64)
  expect(failures).toEqual([])
})
