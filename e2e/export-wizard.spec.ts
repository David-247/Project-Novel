import { expect, test, type Page } from '@playwright/test'
import { editor, launch, nativeDialog, openRecent, pressTab, readFile, saveStatus, seedPreferences, waitForLayout, writeFile, reveal } from './helpers'

/**
 * The export wizard (Phase 4 T8): File > Export > Manuscript… on the wizard fixture (the IR feature
 * fixture plus a double space and a chapter-numbering gap, with its comments and open re-write).
 * The renderers are the e2e build's mock (the bytes are the manuscript as text) until the DOCX / PDF
 * generators are wired at the Wave 2 integration; everything around them is real: the Save dialog
 * grants, the atomic writes, cancel, errors, Export Again, persistence, and the tooltip, keyboard and
 * contrast audits at every step in light and dark.
 */

const FOLDER = '/projects/Night'
const TITLE = 'The Long Night'
const DOCX = '/exports/Waight_THE_LONG_NIGHT_manuscript.docx'
const PDF = '/exports/Waight_THE_LONG_NIGHT_manuscript.pdf'
const STEPS = ['title', 'format', 'checks', 'export'] as const

const wizard = (page: Page) => page.getByTestId('export-wizard')
const ctl = (page: Page, id: string) => wizard(page).locator(`[data-control-id="${id}"]`)
const check = (page: Page, id: string) => wizard(page).locator(`[data-check="${id}"]`)
const written = (page: Page) => page.evaluate(() => [...window.__nvE2E.exports.written.keys()])

async function seed(page: Page) {
  await seedPreferences(page, { profileLegalName: 'Ann Waight', profileEmail: 'ann@example.com', profileAddress: '1 Quay Street\nPort Town' })
  await launch(page)
  const fx = await page.evaluate(() => window.__nvE2E.exportWizardFixture())
  const now = new Date(Date.now() - 60_000).toISOString()
  await writeFile(page, `${FOLDER}/project.json`, JSON.stringify({ format: 'novel-project', schemaVersion: 1, id: 'e2e-night', title: TITLE, createdAt: now, updatedAt: now }))
  await writeFile(page, `${FOLDER}/manuscript.json`, JSON.stringify(fx.doc))
  await writeFile(page, `${FOLDER}/comments.json`, JSON.stringify(fx.comments))
  await writeFile(page, `${FOLDER}/rewrites.json`, JSON.stringify(fx.rewrites))
  await writeFile(page, `${FOLDER}/book.json`, JSON.stringify({ format: 'novel-book', version: 1, styles: fx.styles }))
  await page.evaluate(([f, t]) => window.__nvE2E.addRecent(f, t), [FOLDER, TITLE] as const)
  await openRecent(page, FOLDER)
  await expect(saveStatus(page)).toContainText(`${TITLE}:`)
  await waitForLayout(page)
}

/** File > Export > Manuscript… by its shortcut (from the manuscript), as a user would. */
async function openWizard(page: Page) {
  await editor(page).focus()
  await page.keyboard.press('ControlOrMeta+Shift+X')
  await expect(wizard(page)).toBeVisible()
}

async function goTo(page: Page, step: (typeof STEPS)[number]) {
  await ctl(page, `export.step.${step}`).click()
  await expect(ctl(page, `export.step.${step}`)).toHaveAttribute('aria-current', 'step')
}

async function exportNow(page: Page) {
  await goTo(page, 'export')
  await ctl(page, 'export.start').click()
}

test.describe('export wizard', () => {
  test('a tester completes the wizard on the fixture and gets a DOCX and a PDF', async ({ page }) => {
    await seed(page)
    // The ribbon entry: Layout > Export.
    await (await reveal(page, 'ribbon.cmd.export.manuscript')).click()
    await expect(wizard(page)).toBeVisible()
    // 1. Title page: prefilled from the profile and the project; live preview.
    await expect(ctl(page, 'export.title')).toHaveValue(TITLE)
    await expect(ctl(page, 'export.legalName')).toHaveValue('Ann Waight')
    await expect(wizard(page).getByTestId('preview-byline')).toHaveText('A Novel by Ann Waight')
    await expect(wizard(page).getByTestId('wizard-wordcount')).toContainText(/about \d+ words/)
    await ctl(page, 'export.genre').selectOption('thriller')
    // 2. Formatting (Alt+N): the header preview.
    await page.keyboard.press('Alt+KeyN')
    await expect(ctl(page, 'export.step.format')).toHaveAttribute('aria-current', 'step')
    await expect(wizard(page).getByTestId('preview-header')).toHaveText('Waight / The Long Night / 1')
    // 3. Checks: every check of the ticket fires.
    await page.keyboard.press('Alt+KeyN')
    for (const [id, severity] of [
      ['word-count', 'warning'],
      ['tracked-changes', 'warning'],
      ['comments', 'info'],
      ['rewrites', 'warning'],
      ['chapters', 'warning'],
      ['scene-breaks', 'info'],
      ['formatting', 'info'],
      ['double-spaces', 'info'],
      ['title', 'pass'],
      ['contact', 'pass'],
    ] as const) {
      await expect(check(page, id), id).toHaveAttribute('data-severity', severity)
    }
    await expect(check(page, 'chapters').locator('[data-control-id="export.check.showChapter"]')).toHaveCount(3)
    // 4. Export.
    await page.keyboard.press('Alt+KeyN')
    await expect(wizard(page).getByTestId('export-file-names')).toHaveText('Waight_THE_LONG_NIGHT_manuscript.docxWaight_THE_LONG_NIGHT_manuscript.pdf')
    await page.keyboard.press('Alt+KeyE')
    await expect(wizard(page).getByTestId('export-done')).toBeVisible()
    expect(await written(page)).toEqual([DOCX, PDF])
    expect(await page.evaluate((p) => window.__nvE2E.exportedText(p), DOCX)).toContain('The Arrival')
    // Open file and Show in folder.
    await ctl(page, 'export.openFile').first().click()
    await ctl(page, 'export.showInFolder').last().click()
    await expect.poll(() => page.evaluate(() => [window.__nvE2E.exports.opens, window.__nvE2E.exports.reveals])).toEqual([[DOCX], [PDF]])
    // Close: opened from the ribbon (which keeps no focus), the focus goes back to the manuscript.
    await ctl(page, 'export.finish').click()
    await expect(wizard(page)).toHaveCount(0)
    await expect(editor(page)).toBeFocused()
  })

  test('the in-app menu: File > Export > Manuscript…', async ({ page }) => {
    await seed(page)
    const bar = page.getByRole('menubar', { name: 'Menu bar' })
    test.skip(!(await bar.isVisible()), 'native menu bar (macOS)')
    await bar.locator('[data-control-id="menu.file"]').click()
    await page.locator('[role="menu"] [data-control-id="menu.file.export"]').click()
    await page.locator('[role="menu"] [data-control-id="export.manuscript"]').click()
    await expect(wizard(page)).toBeVisible()
  })

  test('Show me and the review actions close the wizard and go there; reopening returns to Checks', async ({ page }) => {
    await seed(page)
    await openWizard(page)
    await goTo(page, 'checks')
    await check(page, 'chapters').locator('[data-control-id="export.check.showChapter"]').first().click()
    await expect(wizard(page)).toHaveCount(0)
    // The caret is at the untitled chapter (its empty title block), focus in the manuscript.
    await expect(editor(page)).toBeFocused()
    await expect
      .poll(() =>
        page.evaluate(() => {
          const n = window.getSelection()?.anchorNode ?? null
          const el = n && n.nodeType === Node.ELEMENT_NODE ? (n as Element) : (n?.parentElement ?? null)
          return el?.closest('h1')?.textContent ?? null
        }),
      )
      .toBe('')
    await openWizard(page)
    await expect(ctl(page, 'export.step.checks')).toHaveAttribute('aria-current', 'step')
    // Review changes: the next pending change is selected.
    await check(page, 'tracked-changes').locator('[data-control-id="export.check.reviewChanges"]').click()
    await expect(wizard(page)).toHaveCount(0)
    await expect.poll(() => page.evaluate(() => window.getSelection()?.toString().length ?? 0)).toBeGreaterThan(0)
    // Show comments: the comments panel.
    await openWizard(page)
    await check(page, 'comments').locator('[data-control-id="export.check.showComments"]').click()
    await expect(page.getByTestId('comments-panel')).toBeVisible()
    // Open re-write: the comparison view.
    await openWizard(page)
    await check(page, 'rewrites').locator('[data-control-id="export.check.openRewrite"]').click()
    await expect(page.locator('[data-control-id="rewrite.keepOriginal"]').first()).toBeVisible()
  })

  test('blocking checks disable Export until they are resolved', async ({ page }) => {
    await seed(page)
    await openWizard(page)
    // (A project's title cannot be blanked: Book details keeps the old one. Its check is in the unit tests.)
    await ctl(page, 'export.legalName').fill('')
    await ctl(page, 'export.email').fill('')
    await ctl(page, 'export.address').fill('')
    await ctl(page, 'export.address').blur()
    await goTo(page, 'checks')
    await expect(check(page, 'name')).toHaveAttribute('data-severity', 'blocking')
    await expect(check(page, 'contact')).toHaveAttribute('data-severity', 'blocking')
    await goTo(page, 'export')
    await expect(ctl(page, 'export.start')).toHaveAttribute('aria-disabled', 'true')
    // (Playwright will not click an aria-disabled control; a user can, and nothing happens.)
    await ctl(page, 'export.start').dispatchEvent('click')
    expect(await page.evaluate(() => window.__nvE2E.exports.dialogs.length)).toBe(0)
    // Fix: back to the field, focused.
    await goTo(page, 'checks')
    await check(page, 'contact').locator('[data-control-id="export.check.fix"]').first().click()
    await expect(ctl(page, 'export.legalName')).toBeFocused()
    await page.keyboard.type('Ann Waight')
    await ctl(page, 'export.email').fill('ann@example.com')
    await goTo(page, 'export')
    await expect(ctl(page, 'export.start')).not.toHaveAttribute('aria-disabled', 'true')
  })

  test('Cancel during the export leaves no file', async ({ page }) => {
    await seed(page)
    await page.evaluate(() => (window.__nvE2E.mockRender.delayMs = 150))
    await openWizard(page)
    await exportNow(page)
    await expect(ctl(page, 'export.cancelRun')).toBeVisible()
    await ctl(page, 'export.cancelRun').click()
    await expect(wizard(page).getByTestId('export-cancelled')).toBeVisible()
    await page.waitForTimeout(1200)
    expect(await written(page)).toEqual([])
  })

  test('errors come with Retry: a full disk, a folder without permission, a PDF that cannot be made', async ({ page }) => {
    await seed(page)
    await openWizard(page)
    for (const [kind, problem] of [
      ['disk_full', 'disk-full'],
      ['permission_denied', 'permission'],
    ] as const) {
      await page.evaluate((k) => (window.__nvE2E.exports.failWrite = { kind: k, message: `simulated ${k}`, diagnostics: [] }), kind)
      await exportNow(page)
      await expect(wizard(page).getByTestId('export-error')).toHaveAttribute('data-problem', problem)
      await expect(ctl(page, 'export.chooseLocation')).toBeVisible()
      expect(await written(page)).toEqual([])
      await page.evaluate(() => (window.__nvE2E.exports.failWrite = null))
      await ctl(page, 'export.retry').click()
      await expect(wizard(page).getByTestId('export-done')).toBeVisible()
      await page.evaluate(() => window.__nvE2E.exports.written.clear())
    }
    await page.evaluate(() => (window.__nvE2E.mockRender.fail = 'Typst: unknown font family'))
    await exportNow(page)
    await expect(wizard(page).getByTestId('export-error')).toContainText('Typst: unknown font family')
    expect(await written(page)).toEqual([])
    await page.evaluate(() => (window.__nvE2E.mockRender.fail = null))
    await page.keyboard.press('Alt+KeyR')
    await expect(wizard(page).getByTestId('export-done')).toBeVisible()
  })

  test('Export Manuscript Again replaces the same files after confirming, without the wizard', async ({ page }) => {
    await seed(page)
    await openWizard(page)
    await exportNow(page)
    await expect(wizard(page).getByTestId('export-done')).toBeVisible()
    await ctl(page, 'export.finish').click()
    await page.evaluate(() => window.__nvE2E.exports.written.clear())
    await editor(page).focus()
    await page.keyboard.press('ControlOrMeta+Alt+Shift+X')
    await expect(nativeDialog(page)).toContainText('Replace Waight_THE_LONG_NIGHT_manuscript.docx and Waight_THE_LONG_NIGHT_manuscript.pdf')
    await nativeDialog(page).getByRole('button', { name: 'Replace' }).click()
    await expect(page.getByTestId('export-status')).toContainText('Exported Waight_THE_LONG_NIGHT_manuscript.docx')
    await expect(wizard(page)).toHaveCount(0)
    expect(await written(page)).toEqual([DOCX, PDF])
    expect(await page.evaluate(() => window.__nvE2E.exports.dialogs.length)).toBe(2)
  })

  test('settings persist through save and reopen', async ({ page }) => {
    await seed(page)
    await openWizard(page)
    await ctl(page, 'export.genre').selectOption('fantasy')
    await goTo(page, 'format')
    await ctl(page, 'export.preset.classic').check()
    await ctl(page, 'export.paper').selectOption('a4')
    await ctl(page, 'export.sceneBreak').fill('* * *')
    await page.keyboard.press('Escape')
    await editor(page).focus()
    await page.keyboard.press('ControlOrMeta+s')
    await expect(saveStatus(page)).toHaveText(`${TITLE}: Saved`, { timeout: 30_000 })
    const saved = JSON.parse((await readFile(page, `${FOLDER}/export.json`))!)
    expect(saved.settings).toMatchObject({ preset: 'classic', paper: 'a4', sceneBreak: '* * *', checks: { genre: 'fantasy' } })
    await page.reload()
    await expect(page.locator('main [contenteditable="true"]')).toBeVisible()
    await page.waitForFunction(() => !!window.__nvE2E)
    await openRecent(page, FOLDER)
    await expect(saveStatus(page)).toContainText(`${TITLE}:`)
    await openWizard(page)
    await expect(ctl(page, 'export.genre')).toHaveValue('fantasy')
    await goTo(page, 'format')
    await expect(ctl(page, 'export.preset.classic')).toBeChecked()
    await expect(ctl(page, 'export.paper')).toHaveValue('a4')
    await expect(ctl(page, 'export.sceneBreak')).toHaveValue('* * *')
  })
})

// ---- audits ------------------------------------------------------------------------------------

interface Low {
  what: string
  fg: string
  bg: string
  ratio: number
}

/** Text contrast of every text-bearing element in the wizard (computed colours; disabled controls exempt). */
function lowContrast(page: Page): Promise<Low[]> {
  return page.evaluate(() => {
    const parse = (c: string) => {
      const m = c.match(/rgba?\(([^)]+)\)/)
      if (!m) return null
      const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number)
      return [p[0], p[1], p[2], p[3] ?? 1]
    }
    const lum = ([r, g, b]: number[]) => {
      const f = (v: number) => {
        const s = v / 255
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
      }
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
    }
    const background = (el: Element | null): number[] => {
      for (let e = el; e; e = e.parentElement) {
        const c = parse(getComputedStyle(e).backgroundColor)
        if (c && c[3] >= 0.99) return c
      }
      return [255, 255, 255, 1]
    }
    const root = document.querySelector('[data-testid="export-wizard"]')!
    const out: Low[] = []
    for (const el of Array.from(root.querySelectorAll<HTMLElement>('*'))) {
      const own = Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent!.trim())
      if (!own || !el.checkVisibility?.()) continue
      if (el.closest('[aria-disabled="true"], :disabled, [role="img"]')) continue
      const cs = getComputedStyle(el)
      const fg = parse(cs.color)
      if (!fg) continue
      const bg = background(el)
      const a = fg[3]
      const mixed = [0, 1, 2].map((i) => fg[i] * a + bg[i] * (1 - a))
      const [l1, l2] = [lum(mixed), lum(bg)].sort((x, y) => y - x)
      const ratio = (l1 + 0.05) / (l2 + 0.05)
      if (ratio < 4.5) out.push({ what: `${el.tagName} "${el.textContent!.trim().slice(0, 40)}"`, fg: cs.color, bg: `rgb(${bg.slice(0, 3).join(',')})`, ratio: +ratio.toFixed(2) })
    }
    return out
  })
}

/** Tab through the dialog: focus never leaves it, and every enabled control of the step is reached. */
async function keyboardAudit(page: Page, where: string) {
  const expected = await page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>('[data-testid="export-wizard"] [data-control-id]'))
      // A radio group is one Tab stop (the checked radio; arrows move inside it).
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

test.describe('export wizard audits', () => {
  for (const scheme of ['light', 'dark'] as const) {
    test(`tooltips, keyboard and contrast at every step (${scheme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' })
      await seed(page)
      await openWizard(page)
      for (const step of STEPS) {
        await goTo(page, step)
        expect(await page.evaluate(() => window.__nvE2E.auditTooltips()), `tooltips: ${step}`).toEqual([])
        expect(await lowContrast(page), `contrast: ${step}`).toEqual([])
        await keyboardAudit(page, step)
      }
      // The run states too: progress, error, success.
      await page.evaluate(() => (window.__nvE2E.exports.failWrite = { kind: 'disk_full', message: 'full', diagnostics: [] }))
      await ctl(page, 'export.start').click()
      await expect(wizard(page).getByTestId('export-error')).toBeVisible()
      expect(await page.evaluate(() => window.__nvE2E.auditTooltips()), 'tooltips: error').toEqual([])
      expect(await lowContrast(page), 'contrast: error').toEqual([])
      await page.evaluate(() => (window.__nvE2E.exports.failWrite = null))
      await ctl(page, 'export.retry').click()
      await expect(wizard(page).getByTestId('export-done')).toBeVisible()
      expect(await page.evaluate(() => window.__nvE2E.auditTooltips()), 'tooltips: done').toEqual([])
      expect(await lowContrast(page), 'contrast: done').toEqual([])
    })
  }

  test('a tooltip shows on hover and on keyboard focus', async ({ page }) => {
    await seed(page)
    await openWizard(page)
    await ctl(page, 'export.next').hover()
    await expect(page.locator('[data-tooltip-body]')).toContainText('Go to the next step.')
    await page.mouse.move(0, 0)
    await ctl(page, 'export.title').focus()
    await pressTab(page)
    await expect(page.locator('[data-tooltip-body]')).toBeVisible()
  })

  test('a narrow window: the step list becomes a stepper and every step still works', async ({ page }) => {
    await page.setViewportSize({ width: 560, height: 800 })
    await seed(page)
    await openWizard(page)
    // Only the current step's name shows beside the numbers.
    await expect(ctl(page, 'export.step.title')).toContainText('Title page')
    await expect(ctl(page, 'export.step.format').getByText('Formatting')).toBeHidden()
    const box = await wizard(page).boundingBox()
    expect(box!.width).toBeLessThanOrEqual(560)
    for (const step of STEPS) {
      await goTo(page, step)
      expect(await page.evaluate(() => window.__nvE2E.auditTooltips()), `tooltips: ${step}`).toEqual([])
    }
    // Touch-tolerant targets: every control at least 32 px tall (checkbox and radio rows by their label).
    const small = await page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLElement>('[data-testid="export-wizard"] button, [data-testid="export-wizard"] select, [data-testid="export-wizard"] input:not([type=checkbox]):not([type=radio])'))
        .filter((e) => e.checkVisibility?.() && e.getBoundingClientRect().height < 31.5)
        .map((e) => e.getAttribute('data-control-id')),
    )
    expect(small).toEqual([])
  })
})
