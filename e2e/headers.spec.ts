import { expect, test, type Page } from '@playwright/test'
import { buildPaginationFixture } from './fixtures/pagination-manuscript'
import { clickBlockStart, editor, launch, newProject, openRecent, readFile, recoveryControl, saveStatus, seedProject, waitForLayout } from './helpers'

/**
 * Running headers, footers and page numbers (Phase 2, headers/footers ticket). They are drawn in the
 * page margins from the layout model, never in the document.
 */

const ctl = (page: Page, id: string) => page.locator(`[data-control-id="${id}"]`)
const dialog = (page: Page) => page.getByRole('dialog', { name: 'Headers & page numbers' })
const detailsDialog = (page: Page) => page.getByRole('dialog', { name: 'Book details' })
const layout = (page: Page) => page.evaluate(() => window.__nvE2E.layout())

interface Shown {
  index: number
  header: string
  headerNumber: string
  footerNumber: string
}

/** What every rendered page frame shows in its margins. */
async function shown(page: Page): Promise<Shown[]> {
  await waitForLayout(page)
  return page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>('.nv-frames .nv-page')).map((f) => {
      const text = (sel: string) => f.querySelector(sel)?.textContent ?? ''
      return {
        index: Number(f.dataset.pageIndex),
        header: text('[data-hf-region="header"] [data-hf="text"]'),
        headerNumber: text('[data-hf-region="header"] [data-hf="number"]'),
        footerNumber: text('[data-hf-region="footer"] [data-hf="number"]'),
      }
    }),
  )
}

/** Doc: one front matter paragraph, then three chapters (level-1 headings start a page). */
function manuscript(words = 4500) {
  const fx = buildPaginationFixture({ words, chapters: 3 })
  const front = { type: 'paragraph', content: [{ type: 'text', text: 'For my mother, who read every draft.' }] }
  return { type: 'doc', content: [front, ...fx.doc.content] }
}

/** Open the seeded project (author/title set through Book details when asked). */
async function openBook(page: Page, name: string, author = 'Ada Quill', words = 4500) {
  await launch(page)
  await seedProject(page, `/projects/${name}`, name, manuscript(words))
  await openRecent(page, `/projects/${name}`)
  await expect(saveStatus(page)).toHaveText(`${name}: All changes saved`)
  await waitForLayout(page)
  if (author) await setDetails(page, { author })
}

async function setDetails(page: Page, d: { title?: string; author?: string }) {
  await ctl(page, 'book.headerFooter').click()
  await ctl(page, 'book.details').click()
  const dlg = detailsDialog(page)
  await expect(dlg).toBeVisible()
  if (d.title !== undefined) await ctl(page, 'book.details.title').fill(d.title)
  if (d.author !== undefined) await ctl(page, 'book.details.author').fill(d.author)
  await ctl(page, 'book.details.save').click()
  await expect(dialog(page)).toBeVisible() // back in Headers & page numbers
  await ctl(page, 'book.headerFooter.done').click()
  await expect(dialog(page)).toHaveCount(0)
}

/** Independent expectation from the published layout (default settings, front matter unnumbered). */
async function expected(page: Page, title: string, author: string): Promise<Map<number, { header: string; number: string }>> {
  const l = await layout(page)
  const openings = l.pages.filter((p) => p.startsBlockType === 'heading').map((p) => p.index)
  const firstBody = openings[0]
  const out = new Map<number, { header: string; number: string }>()
  for (const p of l.pages) {
    const hidden = p.isBlank || p.index < firstBody || openings.includes(p.index)
    out.set(p.index, hidden ? { header: '', number: '' } : { header: p.side === 'verso' ? author : title, number: String(p.index - firstBody + 1) })
  }
  return out
}

async function expectPagesMatch(page: Page, title: string, author: string) {
  const want = await expected(page, title, author)
  const got = await shown(page)
  expect(got.length).toBeGreaterThan(2)
  for (const g of got) {
    const w = want.get(g.index)!
    expect({ i: g.index, header: g.header, number: g.footerNumber, headerNumber: g.headerNumber }, `page ${g.index}`).toEqual({
      i: g.index,
      header: w.header,
      number: w.number,
      headerNumber: '',
    })
  }
  return { want, got }
}

test('verso and recto headers, arabic numbers from chapter 1, nothing on front matter and chapter openings; correct after a trim change', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  await openBook(page, 'Heads')
  const l0 = await layout(page)
  const openings = l0.pages.filter((p) => p.startsBlockType === 'heading').map((p) => p.index)
  expect(openings.length).toBe(3)
  const first = openings[0]
  expect(first).toBeGreaterThanOrEqual(1) // the front matter page(s) come before

  // Specific pages: the page after the chapter opening is page 2 of the body.
  const { got } = await expectPagesMatch(page, 'Heads', 'Ada Quill')
  const second = got.find((g) => g.index === first + 1)!
  expect(second.footerNumber).toBe('2')
  expect(second.header).toBe((first + 1) % 2 === 1 ? 'Ada Quill' : 'Heads')
  expect(got.find((g) => g.index === 0)).toMatchObject({ header: '', footerNumber: '' })
  expect(got.find((g) => g.index === first)).toMatchObject({ header: '', footerNumber: '' })

  // A trim change reflows; the heads follow the new pages.
  const pagesBefore = l0.pageCount
  await page.evaluate(() => window.__nvE2E.setTrimSize('us-5x8'))
  await waitForLayout(page)
  const l1 = await layout(page)
  expect(l1.pageCount).not.toBe(pagesBefore)
  const { got: after } = await expectPagesMatch(page, 'Heads', 'Ada Quill')
  const open1 = l1.pages.filter((p) => p.startsBlockType === 'heading').map((p) => p.index)
  expect(after.find((g) => g.index === open1[0] + 1)!.footerNumber).toBe('2')
  await page.evaluate(() => window.__nvE2E.setTrimSize('uk-a5'))
  await expectPagesMatch(page, 'Heads', 'Ada Quill')
})

test('blank pages (chapters start on a right-hand page) show no head and no number but are counted', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  await openBook(page, 'Blanks')
  await page.evaluate(() => window.__nvE2E.breakBeforeBlocks({ type: 'heading', level: 1 }, 'recto'))
  await waitForLayout(page)
  const l = await layout(page)
  const blanks = l.pages.filter((p) => p.isBlank)
  expect(blanks.length).toBeGreaterThan(0)
  const got = await shown(page)
  for (const b of blanks) {
    const g = got.find((x) => x.index === b.index)
    if (g) expect(g, `blank page ${b.index}`).toMatchObject({ header: '', headerNumber: '', footerNumber: '' })
  }
  // A blank page still takes a number: the page after it is two on from the one before it.
  await expectPagesMatch(page, 'Blanks', 'Ada Quill')
})

test('settings change the pages at once: roman front matter, custom text, chapter title, outside numbers, starting number', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  await openBook(page, 'Settings')
  const l = await layout(page)
  const first = l.pages.find((p) => p.startsBlockType === 'heading')!.index
  await ctl(page, 'book.headerFooter').click()
  await expect(dialog(page)).toBeVisible()

  await ctl(page, 'book.headerFooter.frontMatter').selectOption('roman')
  await ctl(page, 'book.headerFooter.numberStart').fill('9')
  await ctl(page, 'book.headerFooter.verso').selectOption('custom')
  await ctl(page, 'book.headerFooter.versoText').fill('A Novel')
  await ctl(page, 'book.headerFooter.recto').selectOption('chapter')
  await ctl(page, 'book.headerFooter.numberPosition').selectOption('header-outside')
  await ctl(page, 'book.headerFooter.done').click()
  await expect(dialog(page)).toHaveCount(0)

  const got = await shown(page)
  const front = got.find((g) => g.index === 0)!
  // Page 0 is front matter: its number is "i" in the top corner (header-outside), no header text.
  expect(front).toMatchObject({ header: '', headerNumber: 'i', footerNumber: '' })
  // Two consecutive body pages after the opening: one verso (odd index), one recto.
  const versoIndex = (first + 1) % 2 === 1 ? first + 1 : first + 2
  const rectoIndex = versoIndex === first + 1 ? first + 2 : first + 1
  const verso = got.find((g) => g.index === versoIndex)!
  const recto = got.find((g) => g.index === rectoIndex)!
  expect(verso.header).toBe('A Novel')
  expect(verso.headerNumber).toBe(String(9 + versoIndex - first))
  expect(recto.header).toMatch(/^Chapter 1: /)
  expect(recto.headerNumber).toBe(String(9 + rectoIndex - first))
  expect(recto.footerNumber).toBe('')
  const model = await layout(page)
  expect(model.pageCount).toBe(l.pageCount) // headers never reflow the body
})

test('headers and numbers do not change body pagination: identical page breaks and text positions on and off', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  await openBook(page, 'Box')
  const snapshot = async () => {
    await waitForLayout(page)
    return page.evaluate(() => {
      const l = window.__nvE2E.layout()
      const firstLines = Array.from(document.querySelectorAll('.novel-editor-content > p')).slice(0, 12).map((p) => {
        const r = (p as HTMLElement).getBoundingClientRect()
        return [Math.round(r.left * 10), Math.round(r.top * 10), Math.round(r.width * 10)]
      })
      return { pages: l.pages, version: window.__nvE2E.paginationLines().lineRanges, firstLines }
    })
  }
  const on = await snapshot()
  await ctl(page, 'book.headerFooter').click()
  await ctl(page, 'book.headerFooter.verso').selectOption('none')
  await ctl(page, 'book.headerFooter.recto').selectOption('none')
  await ctl(page, 'book.headerFooter.numberPosition').selectOption('none')
  await ctl(page, 'book.headerFooter.done').click()
  const got = await shown(page)
  expect(got.every((g) => !g.header && !g.footerNumber && !g.headerNumber)).toBe(true)
  const off = await snapshot()
  expect(off.pages).toEqual(on.pages)
  expect(off.version).toEqual(on.version)
  expect(off.firstLines).toEqual(on.firstLines)
  // The head sits inside the margin: never taller than the top margin, clipped by it.
  await ctl(page, 'book.headerFooter').click()
  await ctl(page, 'book.headerFooter.verso').selectOption('custom')
  await ctl(page, 'book.headerFooter.versoText').fill('An exceedingly long running head '.repeat(30))
  await ctl(page, 'book.headerFooter.recto').selectOption('custom')
  await ctl(page, 'book.headerFooter.rectoText').fill('An exceedingly long running head '.repeat(30))
  await ctl(page, 'book.headerFooter.done').click()
  const clipped = await page.evaluate(() => {
    const f = document.querySelector<HTMLElement>('.nv-frames .nv-page[data-page-index="2"]')!
    const slot = f.querySelector<HTMLElement>('.nv-slot-header')!
    const line = slot.querySelector<HTMLElement>('.nv-hf-line')
    return { slot: slot.getBoundingClientRect().height, line: line ? line.getBoundingClientRect().height : 0, overflow: getComputedStyle(slot).overflow }
  })
  expect(clipped.line).toBeLessThanOrEqual(clipped.slot + 0.5)
  const long = await snapshot()
  expect(long.pages).toEqual(on.pages)
  expect(long.firstLines).toEqual(on.firstLines)
})

test('a chapter title edit updates only the heads that show it: other pages keep their DOM nodes, and nothing reflows', async ({ page }) => {
  // Tall window: more rows are rendered (frames are virtualised), so chapter 2's pages sit next to chapter 1's title.
  await page.setViewportSize({ width: 1400, height: 2000 })
  // Short chapters, so chapter 2's pages are rendered (frames are virtualised) next to chapter 1's title.
  await openBook(page, 'Titles', 'Ada Quill', 1800)
  const versionBefore = (await layout(page)).layoutVersion
  await ctl(page, 'book.headerFooter').click()
  await ctl(page, 'book.headerFooter.verso').selectOption('chapter')
  await ctl(page, 'book.headerFooter.recto').selectOption('chapter')
  await ctl(page, 'book.headerFooter.done').click()
  // A header settings change is not a reflow: the layout was not republished.
  const l = await layout(page)
  expect(l.layoutVersion).toBe(versionBefore)

  const openings = l.pages.filter((p) => p.startsBlockType === 'heading').map((p) => p.index)
  const body = openings[0] + 1
  let got = await shown(page)
  const oldTitle = got.find((g) => g.index === body)!.header
  expect(oldTitle).toMatch(/^Chapter 1: /)

  // A page of chapter 2 that shows a head and is rendered now.
  const other = l.pages.find((p) => p.chapterIndex === 1 && !p.isBlank && p.startsBlockType !== 'heading' && got.some((g) => g.index === p.index && g.header))
  expect(other, 'a rendered body page of chapter 2').toBeDefined()
  const otherText = got.find((g) => g.index === other!.index)!.header
  await page.evaluate((i) => {
    const t = document.querySelector(`.nv-frames .nv-page[data-page-index="${i}"] [data-hf="text"]`)!
    t.setAttribute('data-probe', 'kept')
    ;(window as unknown as { __probe: Element }).__probe = t
  }, other!.index)

  // Edit chapter 1's title: click its heading and type.
  const h1 = editor(page).locator('h1').first()
  await h1.click()
  await page.keyboard.press('End')
  await page.keyboard.type(' (revised)')
  await expect.poll(async () => (await shown(page)).find((g) => g.index === body)!.header).toBe(`${oldTitle} (revised)`)
  got = await shown(page)
  // Every page of chapter 1 shows the new title; chapter 2's pages are untouched.
  const l2 = await layout(page)
  for (const p of l2.pages) {
    const g = got.find((x) => x.index === p.index)
    if (!g || !g.header) continue
    if (p.chapterIndex === 0) expect(g.header, `page ${p.index}`).toBe(`${oldTitle} (revised)`)
    else expect(g.header).not.toContain('(revised)')
  }
  // The chapter 2 head is the very same, still attached DOM node, with its attribute and text intact.
  const probe = await page.evaluate((i) => {
    const kept = (window as unknown as { __probe: Element }).__probe
    const now = document.querySelector(`.nv-frames .nv-page[data-page-index="${i}"] [data-hf="text"]`)
    return { same: kept === now, connected: kept.isConnected, attr: kept.getAttribute('data-probe'), text: kept.textContent }
  }, other!.index)
  expect(probe).toEqual({ same: true, connected: true, attr: 'kept', text: otherText })
})

test('running heads are not document content: find, select-all + copy and the document never see them', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  await openBook(page, 'NotContent', 'Ada Quill', 1500)
  const HEAD = 'Zephyr-Quokka-Head'
  await ctl(page, 'book.headerFooter').click()
  await ctl(page, 'book.headerFooter.verso').selectOption('custom')
  await ctl(page, 'book.headerFooter.versoText').fill(HEAD)
  await ctl(page, 'book.headerFooter.recto').selectOption('custom')
  await ctl(page, 'book.headerFooter.rectoText').fill(HEAD)
  await ctl(page, 'book.headerFooter.done').click()
  // It is on the pages...
  expect((await shown(page)).filter((g) => g.header === HEAD).length).toBeGreaterThan(1)
  // ...but not in the document,
  await expect(editor(page)).not.toContainText(HEAD)
  const doc = await page.evaluate(() => window.__nvE2E.editorDiag()!.state)
  expect(doc).not.toContain(HEAD)
  // not found by Find,
  await editor(page).click()
  await page.keyboard.press('ControlOrMeta+f')
  const panel = page.getByRole('region', { name: 'Find and replace' })
  await expect(panel).toBeVisible()
  await panel.getByRole('textbox', { name: 'Find' }).fill(HEAD)
  await page.keyboard.press('Enter')
  await expect(editor(page).locator('.nv-find-match')).toHaveCount(0)
  await panel.getByRole('textbox', { name: 'Find' }).fill('Chapter')
  await expect(editor(page).locator('.nv-find-match').first()).toBeAttached() // find does work
  await page.keyboard.press('Escape')
  // and not copied by select-all + copy.
  await editor(page).click()
  await page.evaluate(() => {
    ;(window as unknown as { __copied: string | null }).__copied = null
    document.addEventListener('copy', (e) => ((window as unknown as { __copied: string | null }).__copied = e.clipboardData?.getData('text/plain') ?? ''), { once: true })
  })
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.press('ControlOrMeta+c')
  await expect.poll(() => page.evaluate(() => (window as unknown as { __copied: string | null }).__copied)).not.toBeNull()
  const copied = await page.evaluate(() => (window as unknown as { __copied: string }).__copied)
  expect(copied.length).toBeGreaterThan(500)
  expect(copied).not.toContain(HEAD)
})

test('the dialog opens from the toolbar button with the keyboard and from a double-click on a header or footer; every control has a tooltip', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  await openBook(page, 'Open')
  const btn = ctl(page, 'book.headerFooter')
  await btn.hover()
  await expect(page.locator('[data-tooltip-body]')).toContainText('Set the page headers and page numbers')
  await btn.focus()
  await page.keyboard.press('Enter')
  await expect(dialog(page)).toBeVisible()
  expect(await page.evaluate(() => window.__nvE2E.auditTooltips())).toEqual([])
  await page.keyboard.press('Escape')
  // The first Escape may only dismiss the button's tooltip.
  if (await dialog(page).count()) await page.keyboard.press('Escape')
  await expect(dialog(page)).toHaveCount(0)
  await expect(btn).toBeFocused()

  // Double-click in the header region of a body page, then in the footer region.
  const l = await layout(page)
  const selection = () => page.evaluate(() => JSON.stringify(window.__nvE2E.editorDiag()!.selection))
  await clickBlockStart(page, editor(page).locator('p').nth(1))
  await page.evaluate(() => window.__nvE2E.syncSelection())
  const caret = await selection()
  const body = l.pages.find((p) => p.startsBlockType === 'heading')!.index + 1
  for (const region of ['header', 'footer'] as const) {
    const slot = page.locator(`.nv-frames .nv-page[data-page-index="${body}"] .nv-slot-${region}`)
    await slot.scrollIntoViewIfNeeded()
    const box = await slot.boundingBox()
    expect(box).not.toBeNull()
    await page.mouse.dblclick(box!.x + box!.width / 2, box!.y + box!.height / 2)
    await expect(dialog(page)).toBeVisible()
    // The presses of the double-click did not move the caret or select a word.
    expect(await selection(), `${region} double-click keeps the selection`).toBe(caret)
    await page.keyboard.press('Escape')
    if (await dialog(page).count()) await page.keyboard.press('Escape')
    await expect(dialog(page)).toHaveCount(0)
    expect(await selection()).toBe(caret)
  }
  // The text itself is untouched by all of this.
  await expect(editor(page)).not.toContainText('Ada Quill')
})

test('settings and details persist across save, reopen and crash recovery', async ({ page, context }) => {
  await page.clock.install()
  await page.setViewportSize({ width: 1400, height: 900 })
  await openBook(page, 'Persist', '')
  await setDetails(page, { title: 'Persistent Book', author: 'P. Writer' })
  // The project title in the status bar follows Book details.
  await expect(saveStatus(page)).toContainText('Persistent Book:')

  await ctl(page, 'book.headerFooter').click()
  await ctl(page, 'book.headerFooter.verso').selectOption('custom')
  await ctl(page, 'book.headerFooter.versoText').fill('Left head')
  await ctl(page, 'book.headerFooter.numberPosition').selectOption('footer-outside')
  await ctl(page, 'book.headerFooter.numberStart').fill('5')
  await ctl(page, 'book.headerFooter.frontMatter').selectOption('roman')
  await ctl(page, 'book.headerFooter.done').click()
  await expect(saveStatus(page)).toContainText('Unsaved changes')
  await page.keyboard.press('ControlOrMeta+s')
  await expect(saveStatus(page)).toContainText('Saved')

  const book = JSON.parse((await readFile(page, '/projects/Persist/book.json'))!)
  expect(book.headerFooter).toMatchObject({
    verso: { kind: 'custom', text: 'Left head' },
    recto: { kind: 'title' },
    pageNumber: { position: 'footer-outside', format: 'arabic', start: 5 },
    frontMatter: 'roman',
    restartAtFirstChapter: true,
  })
  const meta = JSON.parse((await readFile(page, '/projects/Persist/project.json'))!)
  expect(meta).toMatchObject({ title: 'Persistent Book', author: 'P. Writer' })

  // Reopen from disk.
  await page.reload()
  await launch(page)
  await openRecent(page, '/projects/Persist')
  await waitForLayout(page)
  let got = await shown(page)
  const l = await layout(page)
  const first = l.pages.find((p) => p.startsBlockType === 'heading')!.index
  expect(got.find((g) => g.index === 0)!.footerNumber).toBe('i')
  expect(got.find((g) => g.index === first + 1)).toMatchObject({ header: (first + 1) % 2 === 1 ? 'Left head' : 'Persistent Book', footerNumber: '6' })
  await ctl(page, 'book.headerFooter').click()
  await expect(ctl(page, 'book.headerFooter.verso')).toHaveValue('custom')
  await expect(ctl(page, 'book.headerFooter.versoText')).toHaveValue('Left head')
  await expect(ctl(page, 'book.headerFooter.numberStart')).toHaveValue('5')
  await ctl(page, 'book.headerFooter.done').click()

  // Crash recovery: change a setting, let autosave snapshot it, kill the page, restore.
  await page.clock.install()
  await ctl(page, 'book.headerFooter').click()
  await ctl(page, 'book.headerFooter.numberFormat').selectOption('lower-roman')
  await ctl(page, 'book.headerFooter.done').click()
  await expect(saveStatus(page)).toContainText('Unsaved changes')
  await page.clock.runFor(31_000)
  await expect(saveStatus(page)).toContainText('backed up')
  await page.close({ runBeforeUnload: false })

  const relaunched = await context.newPage()
  await launch(relaunched)
  await recoveryControl(relaunched, 'reopen').click()
  await recoveryControl(relaunched, 'restore').click()
  await waitForLayout(relaunched)
  got = await shown(relaunched)
  // Body numbers are Roman now: start 5 -> v, vi.
  expect(got.find((g) => g.index === first + 1)!.footerNumber).toBe('vi')
  await ctl(relaunched, 'book.headerFooter').click()
  await expect(ctl(relaunched, 'book.headerFooter.numberFormat')).toHaveValue('lower-roman')
  await expect(ctl(relaunched, 'book.headerFooter.versoText')).toHaveValue('Left head')
})

test('the dialog has a live mini preview that follows the settings', async ({ page }) => {
  await newProjectWithText(page)
  await ctl(page, 'book.headerFooter').click()
  const preview = page.getByTestId('hf-preview')
  await expect(preview).toBeVisible()
  await expect(preview.locator('[data-preview-page="3"] [data-hf="text"]')).toHaveText('Author Name')
  await expect(preview.locator('[data-preview-page="4"] [data-hf="text"]')).toHaveText('Preview')
  await ctl(page, 'book.headerFooter.recto').selectOption('custom')
  await ctl(page, 'book.headerFooter.rectoText').fill('Hello there')
  await expect(preview.locator('[data-preview-page="4"] [data-hf="text"]')).toHaveText('Hello there')
  await ctl(page, 'book.headerFooter.numberFormat').selectOption('lower-roman')
  await expect(preview.locator('[data-preview-page="4"] [data-hf="number"]')).toHaveText('iii')
  await expect(preview.locator('[data-preview-page="2"] [data-hf="number"]')).toHaveCount(0) // chapter opening
  expect(await page.evaluate(() => window.__nvE2E.auditTooltips())).toEqual([])
})

async function newProjectWithText(page: Page) {
  await launch(page)
  await newProject(page, '/projects/Preview')
  await editor(page).click()
  await page.keyboard.type('Some text.')
}
