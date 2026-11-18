import { expect, test, type Locator, type Page } from '@playwright/test'
import { settled, type Probe } from './contrast'
import { editor, launch, nativeDialog, openRecent, pressTab, reveal, ribbonTab, saveStatus, seedPreferences, waitForLayout, writeFile } from './helpers'

/**
 * Phase 4 acceptance, audits, on the export wizard's fixture (chapters, subheadings, footnotes,
 * tracked changes, comments, an open re-write):
 *  - tooltips: the app-level audit (window.__nvE2E.auditTooltips) with each Phase 4 surface open (the
 *    Navigation Pane, the Word Count dialog, every wizard step and its run states, File > Export and
 *    the ribbon's Layout > Export group, the export status in the status bar, the narrow-window
 *    Export group); then hover and keyboard-focus tooltips on a control of each;
 *  - contrast: WCAG 2.1 AA (text 4.5:1, icons 3:1) of every text and icon of those surfaces, on the
 *    four paper surfaces in OS light and dark (the measurer of e2e/contrast.ts);
 *  - keyboard: the whole Phase 4 flow without a pointer: the pane, Word Count, the wizard from the
 *    menu bar, each step by Tab, the export, Export Manuscript Again and its confirmation, the ribbon.
 * (The macOS native menu bar is exempt from the tooltip rule and is not reachable from a page:
 * decision 4ec247fc. There, File > Export is checked through its shortcuts.)
 */

const FOLDER = '/projects/Audit4'
const TITLE = 'The Long Night'
const ctl = (scope: Page | Locator, id: string) => scope.locator(`[data-control-id="${id}"]`)
const wizard = (page: Page) => page.getByTestId('export-wizard')
const pane = (page: Page) => page.getByRole('complementary', { name: 'Navigation' })
const wordCount = (page: Page) => page.getByRole('dialog', { name: 'Word Count' })
const tip = (page: Page) => page.locator('[data-tooltip-body]')
const menubar = (page: Page) => page.getByRole('menubar', { name: 'Menu bar' })
const focusedId = (page: Page) => page.evaluate(() => document.activeElement?.closest('[data-control-id]')?.getAttribute('data-control-id') ?? null)
const STEPS = ['title', 'format', 'checks', 'export'] as const

async function open(page: Page, width = 1400) {
  await page.setViewportSize({ width, height: 900 })
  await seedPreferences(page, { profileLegalName: 'Ann Waight', profileEmail: 'ann@example.com', profileAddress: '1 Quay Street\nPort Town' })
  await launch(page)
  const fx = await page.evaluate(() => window.__nvE2E.exportWizardFixture())
  const now = new Date(Date.now() - 60_000).toISOString()
  await writeFile(page, `${FOLDER}/project.json`, JSON.stringify({ format: 'novel-project', schemaVersion: 1, id: 'e2e-audit4', title: TITLE, createdAt: now, updatedAt: now }))
  await writeFile(page, `${FOLDER}/manuscript.json`, JSON.stringify(fx.doc))
  await writeFile(page, `${FOLDER}/comments.json`, JSON.stringify(fx.comments))
  await writeFile(page, `${FOLDER}/rewrites.json`, JSON.stringify(fx.rewrites))
  await writeFile(page, `${FOLDER}/book.json`, JSON.stringify({ format: 'novel-book', version: 1, styles: fx.styles }))
  await page.evaluate(([f, t]) => window.__nvE2E.addRecent(f, t), [FOLDER, TITLE] as const)
  await openRecent(page, FOLDER)
  await expect(saveStatus(page)).toHaveText(`${TITLE}: All changes saved`)
  await waitForLayout(page)
}

/**
 * Escape until `layer` is gone: a first Escape may close the tooltip of the focused control (the
 * WAI-ARIA tooltip pattern), the next one the dialog.
 */
async function escapeFrom(page: Page, layer: Locator) {
  await page.keyboard.press('Escape')
  try {
    await expect(layer).toHaveCount(0, { timeout: 1000 })
  } catch {
    await page.keyboard.press('Escape')
    await expect(layer).toHaveCount(0)
  }
}

async function audit(page: Page, where: string, ids: string[] = []) {
  for (const id of ids) await expect(page.locator(`[data-control-id="${id}"]`).first(), `${where}: ${id} rendered`).toBeVisible()
  expect(await page.evaluate(() => window.__nvE2E.auditTooltips()), `tooltips: ${where}`).toEqual([])
}

async function openWizard(page: Page) {
  await editor(page).focus()
  await page.keyboard.press('ControlOrMeta+Shift+X')
  await expect(wizard(page)).toBeVisible()
}

async function goTo(page: Page, step: (typeof STEPS)[number]) {
  await ctl(wizard(page), `export.step.${step}`).click()
  await expect(ctl(wizard(page), `export.step.${step}`)).toHaveAttribute('aria-current', 'step')
}

/** One export to the default files, then the wizard closed: Export Again is enabled. */
async function exportOnce(page: Page) {
  await openWizard(page)
  await goTo(page, 'export')
  await ctl(wizard(page), 'export.start').click()
  await expect(wizard(page).getByTestId('export-done')).toBeVisible()
  await ctl(wizard(page), 'export.finish').click()
  await expect(wizard(page)).toHaveCount(0)
}

// ---- tooltips -----------------------------------------------------------------------------------

test('tooltips: every Phase 4 control, with the pane, Word Count, each wizard step, File > Export, the ribbon and the export status', async ({ page }) => {
  test.setTimeout(180_000)
  await open(page)

  // The Navigation Pane: the audit with it open; a heading's tooltip on hover and on keyboard focus.
  await page.keyboard.press('ControlOrMeta+Shift+O')
  await expect(pane(page)).toBeVisible()
  await audit(page, 'navigation pane', ['outline.resize'])
  await pane(page).locator('[role="treeitem"][data-outline-key="ch:1"]').hover()
  await expect(tip(page)).toContainText('The Storm')
  await page.mouse.move(0, 0)
  await pane(page).locator('[role="treeitem"][data-outline-key="ch:1"]').focus()
  await page.keyboard.press('ArrowDown')
  await expect(tip(page)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(editor(page)).toBeFocused()

  // Word Count: the dialog's controls; its checkbox's tooltip on keyboard focus and on hover.
  await page.keyboard.press('ControlOrMeta+Shift+G')
  await expect(wordCount(page)).toBeVisible()
  await audit(page, 'Word Count dialog')
  const box = wordCount(page).getByRole('checkbox', { name: 'Include footnotes' })
  for (let i = 0; i < 6 && !(await box.evaluate((el) => el === document.activeElement)); i++) await pressTab(page)
  await expect(box).toBeFocused()
  await expect(page.getByRole('tooltip')).toContainText('Count the text of the footnotes too')
  await page.mouse.move(0, 0)
  await wordCount(page).getByRole('button', { name: 'Close' }).last().hover()
  await expect(tip(page)).toBeVisible()
  await wordCount(page).getByRole('button', { name: 'Close' }).last().click()
  await expect(wordCount(page)).toBeHidden()
  // The status bar's word count opens it: a control with a tooltip too.
  await page.locator('[data-control-id="wordCount.indicator"]').hover()
  await expect(tip(page)).toBeVisible()
  await page.mouse.move(0, 0)

  // The wizard: every step, and the run's states (an error, then done).
  await openWizard(page)
  for (const step of STEPS) {
    await goTo(page, step)
    await audit(page, `wizard step ${step}`, [`export.step.${step}`, 'export.close'])
  }
  await page.evaluate(() => (window.__nvE2E.exports.failWrite = { kind: 'disk_full', message: 'full', diagnostics: [] }))
  await ctl(wizard(page), 'export.start').click()
  await expect(wizard(page).getByTestId('export-error')).toBeVisible()
  await audit(page, 'wizard: export error', ['export.retry', 'export.chooseLocation'])
  await page.evaluate(() => (window.__nvE2E.exports.failWrite = null))
  await ctl(wizard(page), 'export.retry').click()
  await expect(wizard(page).getByTestId('export-done')).toBeVisible()
  await audit(page, 'wizard: export done', ['export.openFile', 'export.showInFolder', 'export.finish'])
  await ctl(wizard(page), 'export.openFile').first().hover()
  await expect(tip(page)).toBeVisible()
  await ctl(wizard(page), 'export.finish').click()
  await expect(wizard(page)).toHaveCount(0)

  // File > Export (the in-app menu bar; macOS uses the native one).
  if (await menubar(page).isVisible()) {
    await menubar(page).locator('[data-control-id="menu.file"]').click()
    await page.locator('[role="menu"] [data-control-id="menu.file.export"]').click()
    await expect(page.getByRole('menu')).toHaveCount(2)
    await audit(page, 'File > Export', ['export.manuscript', 'export.again'])
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    await expect(page.getByRole('menu')).toHaveCount(0)
  }

  // The ribbon: Layout > Export (Manuscript…, Export Manuscript Again), hover and keyboard focus.
  await ribbonTab(page, 'layout')
  await audit(page, 'ribbon Layout', ['ribbon.cmd.export.manuscript', 'ribbon.cmd.export.again'])
  await (await reveal(page, 'ribbon.cmd.export.manuscript')).hover()
  await expect(tip(page)).toContainText('Export a Word file and a PDF in standard manuscript format')
  await page.mouse.move(0, 0)
  await (await reveal(page, 'ribbon.cmd.export.again')).focus()
  await page.keyboard.press('ArrowLeft')
  await expect.poll(() => focusedId(page)).toBe('ribbon.cmd.export.manuscript')
  await expect(tip(page)).toBeVisible()

  // The export status in the status bar (Export Manuscript Again runs there, without the wizard).
  await editor(page).focus()
  await page.keyboard.press('ControlOrMeta+Alt+Shift+X')
  await nativeDialog(page).getByRole('button', { name: 'Replace' }).click()
  await expect(page.getByTestId('export-status')).toContainText('Exported')
  await audit(page, 'export status', ['export.status.show', 'export.status.dismiss'])
  await page.locator('[data-control-id="export.status.dismiss"]').hover()
  await expect(tip(page)).toBeVisible()
  await page.mouse.move(0, 0)

  // A narrow window: groups collapse into menu buttons (how far depends on the fonts); their menus
  // pass the audit too.
  await page.setViewportSize({ width: 600, height: 800 })
  await ribbonTab(page, 'layout')
  const row = page.locator('[data-ribbon-panel="layout"]')
  const triggers = await row.locator('[data-control-id^="ribbon.group."], [data-control-id="ribbon.more"]').evaluateAll((els) =>
    els.filter((e) => (e as HTMLElement).offsetParent !== null).map((e) => e.getAttribute('data-control-id')!),
  )
  await audit(page, 'narrow ribbon Layout')
  for (const id of triggers) {
    await row.locator(`[data-control-id="${id}"]`).click()
    await expect(page.getByRole('menu').first()).toBeVisible()
    await audit(page, `narrow Layout: ${id}`)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('menu')).toHaveCount(0)
  }
  // Collapsed or not, Manuscript… is still reachable (in its group's menu or More when collapsed).
  await expect((await reveal(page, 'ribbon.cmd.export.manuscript')).first()).toBeVisible()
})

// ---- contrast -----------------------------------------------------------------------------------

const SURFACES = ['auto', 'book', 'white', 'dark'] as const
const SCHEMES = ['light', 'dark'] as const

/**
 * Mark every text-bearing element and every icon-only control inside `root` (visible ones) for the
 * measurer: text by its colour on its composited background (4.5:1), an icon by its strokes and fills (3:1).
 */
async function mark(page: Page, name: string, root: string): Promise<number> {
  return page.evaluate(
    ([n, sel]) => {
      document.querySelectorAll(`[data-nv-probe="${n}"]`).forEach((e) => e.removeAttribute('data-nv-probe'))
      let k = 0
      for (const r of Array.from(document.querySelectorAll(sel))) {
        for (const el of [r, ...Array.from(r.querySelectorAll('*'))]) {
          if (!el.checkVisibility?.() || el.closest('svg')) continue
          const own = Array.from(el.childNodes).some((c) => c.nodeType === 3 && c.textContent!.trim())
          const icon = el.matches('[data-control-id]') && !el.textContent!.trim() && !!el.querySelector('svg')
          if (own || icon) {
            el.setAttribute('data-nv-probe', n)
            k++
          }
        }
      }
      return k
    },
    [name, root] as const,
  )
}

const probe = (name: string, min: number): Probe => ({ what: name, sel: `[data-nv-probe="${name}"]`, kind: 'auto', all: true, min })

test('WCAG AA contrast of the Phase 4 UI: four paper surfaces x OS light and dark', async ({ page }) => {
  test.setTimeout(300_000)
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
  await open(page)
  await exportOnce(page)
  // Export Again once: the status bar's export status stays until dismissed.
  await editor(page).focus()
  await page.keyboard.press('ControlOrMeta+Alt+Shift+X')
  await nativeDialog(page).getByRole('button', { name: 'Replace' }).click()
  await expect(page.getByTestId('export-status')).toContainText('Exported')
  await page.keyboard.press('ControlOrMeta+Shift+O')
  await expect(pane(page)).toBeVisible()
  // The current heading (highlighted) too: the caret in a subheading's section.
  await pane(page).locator('[role="treeitem"][data-outline-key="ch:1/sub:0"]').click()
  await expect(pane(page).locator('[role="treeitem"][data-outline-key="ch:1/sub:0"]')).toHaveAttribute('aria-selected', 'true')
  await ribbonTab(page, 'layout')

  const failures: string[] = []
  let checked = 0
  let lowest = { ratio: Infinity, label: '' }
  const take = async (where: string, parts: [string, string, number][]) => {
    const probes: Probe[] = []
    for (const [name, root, min] of parts) {
      const n = await mark(page, name, root)
      if (n < min) failures.push(`${where} ${name}: ${n} of at least ${min} elements found (${root})`)
      probes.push(probe(name, min))
    }
    const got = await settled(page, probes)
    for (const m of got.missing) failures.push(`${where} ${m}`)
    for (const e of got.errors) failures.push(`${where} ${e}`)
    for (const x of got.samples) {
      checked++
      if (x.ratio / x.min < lowest.ratio) lowest = { ratio: x.ratio / x.min, label: `${where} ${x.what}: ${x.ratio}:1 (min ${x.min}; fg ${x.fg} on ${x.bg})` }
      if (x.ratio < x.min) failures.push(`${where} ${x.what} "${x.probe}": ${x.ratio}:1 < ${x.min}:1 (fg ${x.fg} on ${x.bg})`)
    }
  }
  for (const scheme of SCHEMES) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' })
    await expect(page.locator('html')).toHaveAttribute('data-theme', scheme)
    for (const surface of SURFACES) {
      const where = `${scheme}/${surface}`
      await page.evaluate((s) => window.__nvE2E.runCommand(`book.surface.${s}`), surface)
      const resolved = surface === 'auto' ? (scheme === 'light' ? 'white' : 'dark') : surface
      await expect(page.locator('html')).toHaveAttribute('data-surface', resolved)
      await take(where, [
        ['navigation pane', 'aside[aria-label="Navigation"]', 20],
        ['status bar (word count, export status)', 'footer[aria-label="Status bar"]', 4],
        ['ribbon Layout (Export group)', '[data-ribbon-panel="layout"]', 6],
      ])
      // The Word Count dialog.
      await editor(page).focus()
      await page.keyboard.press('ControlOrMeta+Shift+G')
      await expect(wordCount(page)).toBeVisible()
      await take(`${where} Word Count`, [['Word Count dialog', '[role="dialog"]', 10]])
      await escapeFrom(page, wordCount(page))
      // The wizard, every step.
      await openWizard(page)
      for (const step of STEPS) {
        await goTo(page, step)
        await page.mouse.move(0, 0)
        await take(`${where} wizard ${step}`, [[`wizard ${step}`, '[data-testid="export-wizard"]', 8]])
      }
      await ctl(wizard(page), 'export.close').click()
      await expect(wizard(page)).toHaveCount(0)
    }
  }
  console.info(`[phase4 contrast] ${checked} samples checked; lowest (ratio / minimum) ${lowest.ratio.toFixed(2)}: ${lowest.label}`)
  expect(failures).toEqual([])
})

// ---- keyboard -------------------------------------------------------------------------------------

/** Press `key` until the focus is on `target` (each press waits for the focus to move on). */
async function keyTo(page: Page, key: string, target: string, max = 60) {
  for (let i = 0; i < max; i++) {
    const before = await focusedId(page)
    if (before === target) return
    await page.keyboard.press(key)
    await expect.poll(() => focusedId(page), `${key} moves the focus on from ${before}`).not.toBe(before)
  }
  expect(await focusedId(page), `${target} reached with ${key}`).toBe(target)
}

/** Tab (Option+Tab in macOS WebKit: `pressTab`) until the focus is on `target`. */
async function tabTo(page: Page, target: string, max = 40) {
  for (let i = 0; i < max && (await focusedId(page)) !== target; i++) await pressTab(page)
  expect(await focusedId(page), `${target} reached with Tab`).toBe(target)
}

/** Tab through the wizard's step: focus never leaves it, every enabled control is reached, each with a focus ring. */
async function tabThrough(page: Page, where: string) {
  const expected = await page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>('[data-testid="export-wizard"] [data-control-id]'))
      .filter((e) => !(e as HTMLButtonElement).disabled && e.checkVisibility?.() !== false && !((e as HTMLInputElement).type === 'radio' && !(e as HTMLInputElement).checked))
      .map((e) => e.getAttribute('data-control-id')!),
  )
  const seen = new Set<string>()
  for (let i = 0; i < expected.length + 6; i++) {
    await pressTab(page)
    const info = await page.evaluate(() => {
      const a = document.activeElement as HTMLElement | null
      return { inside: !!a?.closest('[data-testid="export-wizard"]'), id: a?.getAttribute('data-control-id') ?? null, ring: a ? getComputedStyle(a).outlineStyle : 'none' }
    })
    expect(info.inside, `${where}: focus left the wizard`).toBe(true)
    if (info.id) {
      seen.add(info.id)
      expect(info.ring, `${where}: ${info.id} shows focus`).not.toBe('none')
    }
  }
  expect([...new Set(expected)].filter((id) => !seen.has(id)), `${where}: not reached by Tab`).toEqual([])
}

test('keyboard only: the pane, Word Count, the wizard (menu bar, every step, export), Export Again, the ribbon', async ({ page }) => {
  test.setTimeout(180_000)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await open(page)
  await editor(page).focus()

  // The pane: shortcut, arrows, Enter jumps (caret at The Storm), Escape back to the manuscript.
  await page.keyboard.press('ControlOrMeta+Shift+O')
  await expect(pane(page)).toBeVisible()
  await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('[role="tree"]'))).toBe(true)
  await page.keyboard.press('Home')
  const storm = pane(page).locator('[role="treeitem"][data-outline-key="ch:1"]')
  for (let i = 0; i < 6 && !(await storm.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press('ArrowDown')
  await expect(storm).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(editor(page)).toBeFocused()
  await expect.poll(() => page.evaluate(() => (window.getSelection()?.anchorNode?.parentElement?.closest('h1')?.textContent ?? '') as string)).toBe('The Storm')
  await page.keyboard.press('ControlOrMeta+Shift+O')
  await expect(pane(page)).toBeHidden()

  // Word Count: the shortcut, Tab to the checkbox, Space, Escape.
  await page.keyboard.press('ControlOrMeta+Shift+G')
  await expect(wordCount(page)).toBeVisible()
  const box = wordCount(page).getByRole('checkbox', { name: 'Include footnotes' })
  for (let i = 0; i < 6 && !(await box.evaluate((el) => el === document.activeElement)); i++) await pressTab(page)
  await expect(box).toBeFocused()
  await page.keyboard.press('Space')
  await expect(box).not.toBeChecked()
  await page.keyboard.press('Space')
  await expect(box).toBeChecked()
  await page.keyboard.press('Escape')
  await expect(wordCount(page)).toBeHidden()
  await expect(editor(page)).toBeFocused()

  // The wizard from the menu bar (F10, File, Export, Manuscript…), or its shortcut where the menu bar is native.
  if (await menubar(page).isVisible()) {
    await page.keyboard.press('F10')
    await expect.poll(() => focusedId(page)).toMatch(/^menu\./)
    await keyTo(page, 'ArrowLeft', 'menu.file', 8)
    await page.keyboard.press('ArrowDown')
    await expect(page.getByRole('menu').first()).toBeVisible()
    await keyTo(page, 'ArrowDown', 'menu.file.export')
    await page.keyboard.press('ArrowRight')
    await expect(page.getByRole('menu')).toHaveCount(2)
    await keyTo(page, 'ArrowDown', 'export.manuscript')
    await page.keyboard.press('Enter')
  } else {
    await page.keyboard.press('ControlOrMeta+Shift+X')
  }
  await expect(wizard(page)).toBeVisible()
  // Every step: Tab reaches every control (with a focus ring) and stays in the wizard; Alt+N moves on.
  for (const [i, step] of STEPS.entries()) {
    await expect(ctl(wizard(page), `export.step.${step}`)).toHaveAttribute('aria-current', 'step')
    await tabThrough(page, step)
    if (i < STEPS.length - 1) await page.keyboard.press('Alt+KeyN')
  }
  // A field typed into from the keyboard (Alt+1 back to the Title page, Tab to the genre).
  await page.keyboard.press('Alt+Digit1')
  await expect(ctl(wizard(page), 'export.step.title')).toHaveAttribute('aria-current', 'step')
  await tabTo(page, 'export.genre')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Alt+Digit4')
  await expect(ctl(wizard(page), 'export.step.export')).toHaveAttribute('aria-current', 'step')
  // Export (Alt+E); then Tab to Close and Enter: back in the manuscript.
  await page.keyboard.press('Alt+KeyE')
  await expect(wizard(page).getByTestId('export-done')).toBeVisible()
  await expect.poll(() => page.evaluate(() => [...window.__nvE2E.exports.written.keys()].length)).toBe(2)
  await tabTo(page, 'export.finish')
  await page.keyboard.press('Enter')
  await expect(wizard(page)).toHaveCount(0)
  await expect(editor(page)).toBeFocused()

  // Export Manuscript Again: the shortcut, and the confirmation answered from the keyboard.
  await page.evaluate(() => window.__nvE2E.exports.written.clear())
  await page.keyboard.press('ControlOrMeta+Alt+Shift+X')
  await expect(nativeDialog(page)).toBeVisible()
  // (In the app this is the OS's own message box, answered with its keys; the e2e backend draws a
  // stand-in, so the key goes to its button.)
  await nativeDialog(page).getByRole('button', { name: 'Replace' }).press('Enter')
  await expect(page.getByTestId('export-status')).toContainText('Exported')
  expect(await page.evaluate(() => [...window.__nvE2E.exports.written.keys()].length)).toBe(2)

  // The ribbon: Shift+Tab from the manuscript to the ribbon, the arrows to Layout, Enter, then Export > Manuscript….
  await editor(page).focus()
  const inRibbon = () => page.evaluate(() => !!document.activeElement?.closest('[role="toolbar"][aria-label="Formatting"]'))
  for (let i = 0; i < 6 && !(await inRibbon()); i++) {
    const before = await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 200) ?? '')
    await pressTab(page, { shift: true })
    await expect.poll(() => page.evaluate(() => document.activeElement?.outerHTML.slice(0, 200) ?? '')).not.toBe(before)
  }
  expect(await inRibbon(), 'the ribbon reached with Shift+Tab from the manuscript').toBe(true)
  await page.keyboard.press('Home')
  await keyTo(page, 'ArrowRight', 'ribbon.tab.home', 6)
  await keyTo(page, 'ArrowRight', 'ribbon.tab.layout', 6)
  await page.keyboard.press('Enter')
  await expect(page.locator('[data-control-id="ribbon.tab.layout"]')).toHaveAttribute('aria-selected', 'true')
  await keyTo(page, 'ArrowRight', 'ribbon.cmd.export.manuscript', 40)
  await page.keyboard.press('Enter')
  await expect(wizard(page)).toBeVisible()
  await escapeFrom(page, wizard(page))
  // The focus goes back where the wizard was opened from: the ribbon button (a keyboard user's place).
  await expect.poll(() => focusedId(page)).toBe('ribbon.cmd.export.manuscript')
})
