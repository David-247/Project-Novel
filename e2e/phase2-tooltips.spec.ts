import { expect, test, type Page } from '@playwright/test'
import { buildPaginationFixture } from './fixtures/pagination-manuscript'
import { clickBlockStart, editor, launch, openRecent, pressTab, saveStatus, seedProject, waitForLayout } from './helpers'

/**
 * Phase 2 acceptance, tooltip coverage: the app-level audit (window.__nvE2E.auditTooltips, i.e.
 * auditTooltipCoverage over the whole page incl. portals) in the paginated spread view, with every
 * Phase 2 menu, dialog and popover open in turn; hover and keyboard-focus tooltips on the Phase 2
 * toolbar and status bar controls.
 */

const ctl = (page: Page, id: string) => page.locator(`[data-control-id="${id}"]`)
const tip = (page: Page) => page.locator('[data-tooltip-body]')

/** Phase 2 controls always present in the spread view (toolbar and status bar). */
const PHASE2_CONTROLS = [
  'book.trimSize',
  'styles.picker',
  'styles.edit',
  'styles.manage',
  'styles.clearFormatting',
  'insert.menu',
  'footnote.options',
  'book.headerFooter',
  'book.surface.auto',
  'book.surface.book',
  'book.surface.white',
  'book.surface.dark',
  'pagination.spreadView',
  'pagination.zoomOut',
  'pagination.zoom',
  'pagination.zoomIn',
]

async function audit(page: Page, where: string, ids: string[] = []) {
  for (const id of ids) await expect(ctl(page, id).first(), `${where}: ${id} rendered`).toBeVisible()
  expect(await page.evaluate(() => window.__nvE2E.auditTooltips()), where).toEqual([])
}

async function pointerAway(page: Page) {
  const box = (await page.getByRole('main', { name: 'Editor' }).boundingBox())!
  await page.mouse.move(box.x + 8, box.y + box.height - 8, { steps: 6 })
}

/** Escape closes an open tooltip first (app-wide behaviour), then the dialog or menu. */
async function escapeFrom(page: Page, layer: ReturnType<Page['locator']>) {
  await page.keyboard.press('Escape')
  try {
    await expect(layer).toHaveCount(0, { timeout: 1000 })
  } catch {
    await page.keyboard.press('Escape')
    await expect(layer).toHaveCount(0)
  }
}

async function openBook(page: Page) {
  await page.setViewportSize({ width: 1400, height: 900 })
  await launch(page)
  const fx = buildPaginationFixture({ words: 6000, chapters: 3 })
  // One footnote in the second paragraph, so the reference and its popover can be audited too.
  const content = fx.doc.content as { type: string; content: unknown[] }[]
  content[2] = { ...content[2], content: [...content[2].content, { type: 'footnote', content: [{ type: 'text', text: 'A note.' }] }] }
  await seedProject(page, '/projects/Tips2', 'Tips2', { type: 'doc', content })
  await openRecent(page, '/projects/Tips2')
  await expect(saveStatus(page)).toHaveText('Tips2: All changes saved')
  await waitForLayout(page)
  expect((await page.evaluate(() => window.__nvE2E.layout())).effectiveView).toBe('spread')
}

test('spread view: every Phase 2 control has a wired tooltip, with each menu, dialog and popover open', async ({ page }) => {
  test.setTimeout(120_000)
  await openBook(page)
  await audit(page, 'spread view', PHASE2_CONTROLS)
  await expect(page.getByTestId('page-indicator')).toHaveText(/^Pages? \d/)

  // Trim size menu (one control per size).
  await ctl(page, 'book.trimSize').click()
  await expect(page.getByRole('menuitemradio')).toHaveCount(9)
  await audit(page, 'trim size menu', ['book.trimSize.uk-a5', 'book.trimSize.us-6x9'])
  await escapeFrom(page, page.getByRole('menu'))

  // Insert menu: breaks, chapters start on, ornaments, footnote.
  await ctl(page, 'insert.menu').click()
  await audit(page, 'insert menu', ['insert.pageBreak', 'insert.newChapter', 'insert.sceneBreak', 'insert.chapterStart.page', 'insert.chapterStart.recto', 'footnote.insert'])
  await escapeFrom(page, page.getByRole('menu'))

  // Modify style (from a chapter title) and Manage styles.
  await clickBlockStart(page, editor(page).locator('h1').first())
  await ctl(page, 'styles.edit').click()
  const modify = page.getByRole('dialog', { name: /^Modify style/ })
  await expect(modify).toBeVisible()
  await audit(page, 'Modify style dialog', ['styles.field.fontSize', 'styles.field.breakBefore', 'styles.modify.save', 'styles.modify.cancel'])
  await ctl(page, 'styles.modify.cancel').click()
  await expect(modify).toHaveCount(0)
  await ctl(page, 'styles.manage').click()
  const manage = page.getByRole('dialog', { name: 'Manage styles' })
  await expect(manage).toBeVisible()
  await audit(page, 'Manage styles dialog', ['styles.manage.new', 'styles.manage.duplicate', 'styles.manage.modify'])
  await escapeFrom(page, manage)

  // Headers & page numbers, and Book details stacked on it.
  await ctl(page, 'book.headerFooter').click()
  const hf = page.getByRole('dialog', { name: 'Headers & page numbers' })
  await expect(hf).toBeVisible()
  await audit(page, 'Headers & page numbers dialog', [
    'book.headerFooter.verso',
    'book.headerFooter.recto',
    'book.headerFooter.numberPosition',
    'book.headerFooter.numberFormat',
    'book.headerFooter.numberStart',
    'book.headerFooter.frontMatter',
    'book.headerFooter.restart',
    'book.headerFooter.suppressHeader',
    'book.headerFooter.suppressNumber',
    'book.headerFooter.suppressBlank',
    'book.details',
    'book.headerFooter.done',
  ])
  await ctl(page, 'book.headerFooter.verso').selectOption('custom')
  await audit(page, 'Headers dialog with custom text', ['book.headerFooter.versoText'])
  await ctl(page, 'book.details').click()
  const details = page.getByRole('dialog', { name: 'Book details' })
  await expect(details).toBeVisible()
  await audit(page, 'Book details dialog', ['book.details.title', 'book.details.author', 'book.details.save', 'book.details.cancel'])
  await ctl(page, 'book.details.cancel').click()
  await expect(details).toHaveCount(0)
  await ctl(page, 'book.headerFooter.done').click()
  await expect(hf).toHaveCount(0)

  // Footnote options, and the footnote editor popover opened from the reference.
  await ctl(page, 'footnote.options').click()
  const fno = page.getByRole('dialog', { name: 'Footnote options' })
  await expect(fno).toBeVisible()
  await audit(page, 'Footnote options dialog', ['footnote.options.numbering', 'footnote.options.format', 'footnote.options.separator', 'footnote.options.done'])
  await ctl(page, 'footnote.options.done').click()
  await expect(fno).toHaveCount(0)
  await editor(page).locator('[data-footnote-ref]').first().click()
  await expect(page.getByTestId('footnote-popover')).toBeVisible()
  await audit(page, 'footnote popover', ['footnote.done'])
  await ctl(page, 'footnote.done').click()
  await expect(page.getByTestId('footnote-popover')).toHaveCount(0)

  // Single-page view (spread toggle off), and back.
  await ctl(page, 'pagination.spreadView').click()
  await expect(ctl(page, 'pagination.spreadView')).toHaveAttribute('aria-pressed', 'false')
  await audit(page, 'single-page view', PHASE2_CONTROLS)
  await ctl(page, 'pagination.spreadView').click()
  await expect(ctl(page, 'pagination.spreadView')).toHaveAttribute('aria-pressed', 'true')
})

test('Phase 2 toolbar and status bar controls show their tooltip on hover and on keyboard focus', async ({ page }) => {
  test.setTimeout(120_000)
  await openBook(page)
  for (const id of PHASE2_CONTROLS) {
    await pointerAway(page)
    await expect(tip(page)).toHaveCount(0)
    await ctl(page, id).hover()
    await expect(tip(page), `hover tooltip for ${id}`).toBeVisible()
    await expect(tip(page), `hover tooltip for ${id}`).toHaveText(/\w.{8,}/)
  }
  await pointerAway(page)

  // Keyboard: the toolbar's roving focus (arrow keys) through the Phase 2 groups.
  // (Clear direct formatting may be disabled with nothing to clear; roving focus then skips it.)
  const focusedId = () => page.evaluate(() => document.activeElement?.closest('[data-control-id]')?.getAttribute('data-control-id') ?? null)
  await ctl(page, 'styles.picker').focus()
  const targets = new Set(['styles.edit', 'styles.manage', 'insert.menu', 'footnote.options', 'book.headerFooter', 'book.trimSize'])
  for (let i = 0; i < 16 && targets.size; i++) {
    const before = await focusedId()
    await page.keyboard.press('ArrowRight')
    await expect.poll(focusedId, `roving focus moves on from ${before}`).not.toBe(before)
    const id = (await focusedId())!
    if (!targets.has(id)) continue
    await expect(tip(page), `focus tooltip for ${id}`).toBeVisible()
    targets.delete(id)
  }
  expect([...targets], 'Phase 2 toolbar controls reached with ArrowRight').toEqual([])
  await page.keyboard.press('Escape')

  // Keyboard: Tab order in the status bar (spread toggle, zoom out, zoom, zoom in).
  await ctl(page, 'pagination.spreadView').focus()
  for (const id of ['pagination.zoomOut', 'pagination.zoom', 'pagination.zoomIn']) {
    await pressTab(page)
    const active = await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 160))
    await expect(ctl(page, id), `${id}; focused: ${active}`).toBeFocused()
    await expect(tip(page), `focus tooltip for ${id}`).toBeVisible()
  }
  // Paper picker: arrow keys move between options and show each tooltip.
  await ctl(page, 'book.surface.auto').focus()
  for (const id of ['book.surface.book', 'book.surface.white', 'book.surface.dark']) {
    await page.keyboard.press('ArrowRight')
    await expect(ctl(page, id)).toBeFocused()
    await expect(tip(page), `focus tooltip for ${id}`).toBeVisible()
  }
})
