import { expect, test, type BrowserContext, type Page, type TestInfo } from '@playwright/test'
import { strFromU8, unzipSync } from 'fflate'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { readPdf, renderWithSidecar, REQUIRE_TYPST, ROOT, SIDECAR, type PdfPage, type ReadPdf } from '../src/features/export/pdf/test-harness'
import { buildPaginationFixture } from './fixtures/pagination-manuscript'
import {
  crashAndRestore,
  editor,
  launch,
  lineEnd,
  nativeDialog,
  openRecent,
  pressAccessKey,
  projectNavigation,
  readFile,
  reopenProject,
  saveProject,
  saveStatus,
  seedPreferences,
  seedProject,
  seedProjectNavigation,
  turnSettled,
  waitForLayout,
  writeFile,
} from './helpers'

/**
 * Phase 4 acceptance (Publisher-Ready Manuscript Export), end to end through the UI, in chromium and
 * webkit:
 *  1. the 100k-word book: open the Navigation Pane, jump to several chapters (Book mode and, in the
 *     *-scroll projects, Scroll mode), type, and the word and page counts follow live (status bar,
 *     pane rows, pane total);
 *  2. the feature fixture: the wizard's title page, formatting and checks (a blocking check fixed
 *     through its Fix action), then DOCX and PDF; the outputs asserted (the DOCX XML; the PDF text,
 *     read with pdfjs: title page, running headers, page numbers, chapter starts); the settings
 *     survive save, reopen and crash recovery; Export Manuscript Again, in the session and after a
 *     restart;
 *  3. the 100k-word book exported to DOCX and PDF, every chapter on a new page;
 *  4. offline: both exports with every non-local request refused, and none made.
 * The PDF the app gets in the browser e2e is the fake core's stub (no Typst in a browser), so the PDF
 * assertions render the request the app sent to the Rust command (template id + data.json + font role)
 * with the real Typst sidecar, as Rust would (src/features/export/pdf/test-harness.ts). Without the
 * sidecar (`pnpm fetch:typst`) they are skipped, unless NOVEL_REQUIRE_TYPST=1 (CI) makes that a failure.
 * The exported files are kept in e2e-exports/ (CI uploads them; macOS CI renders the PDF with Quick
 * Look and PDFKit for the manual check).
 */

const BOTH_MODES = '@both-modes'
test.beforeEach(async ({ page }, testInfo) => {
  test.skip(projectNavigation(testInfo) === 'scroll' && !testInfo.tags.includes(BOTH_MODES), 'Book mode scenario (the navigation test runs in both)')
  await seedProjectNavigation(page, testInfo)
})

const PROFILE = { profileLegalName: 'Ann Waight', profileEmail: 'ann@example.com', profileAddress: '1 Quay Street\nPort Town' }
const EXPORTS = join(ROOT, 'e2e-exports')

const wizard = (page: Page) => page.getByTestId('export-wizard')
const ctl = (page: Page, id: string) => wizard(page).locator(`[data-control-id="${id}"]`)
const check = (page: Page, id: string) => wizard(page).locator(`[data-check="${id}"]`)
const written = (page: Page) => page.evaluate(() => [...window.__nvE2E.exports.written.keys()])
const pane = (page: Page) => page.getByRole('complementary', { name: 'Navigation' })
const row = (page: Page, key: string) => page.locator(`[role="treeitem"][data-outline-key="${key}"]`)
const rowCounts = (page: Page, key: string) => row(page, key).locator('[data-outline-counts]')
const layout = (page: Page) => page.evaluate(() => window.__nvE2E.layout())
const caret = (page: Page) => page.evaluate(() => window.__nvE2E.selection()!.from)
const blockPos = (page: Page, i: number) => page.evaluate((k) => window.__nvE2E.blockPos(k), i)
const num = (s: string) => Number(s.replace(/,/g, ''))

async function exported(page: Page, path: string): Promise<Uint8Array> {
  const bytes = await page.evaluate((p) => window.__nvE2E.exportedBytes(p), path)
  expect(bytes, path).not.toBeNull()
  return Uint8Array.from(bytes!)
}

/** Keep an output for the manual check and the CI artifact: e2e-exports/<name>-<browser>-<os>.<ext>. */
function keep(testInfo: TestInfo, name: string, ext: string, bytes: Uint8Array) {
  mkdirSync(EXPORTS, { recursive: true })
  writeFileSync(join(EXPORTS, `${name}-${testInfo.project.name}-${process.platform}.${ext}`), bytes)
}

const sidecarReady = () => {
  if (SIDECAR) return true
  expect(REQUIRE_TYPST, 'the Typst sidecar is missing: run `pnpm fetch:typst`').toBe(false)
  test.info().annotations.push({ type: 'skipped', description: 'PDF text checks: no Typst sidecar (pnpm fetch:typst)' })
  return false
}

/**
 * The PDF of the app's last render request, made by the real Typst sidecar from exactly what the app
 * sent (the fake core recorded it), and read back with pdfjs. Null without a sidecar.
 */
async function realPdf(page: Page, testInfo: TestInfo, name: string): Promise<ReadPdf | null> {
  const req = await page.evaluate(() => {
    const r = window.__nvE2E.exports.renders
    return r[r.length - 1] as { template: string; data: string; font: 'serif' | 'mono' }
  })
  expect(req.template).toBe('manuscript')
  if (!sidecarReady()) return null
  const { pdf } = await renderWithSidecar(req.data, req.font)
  keep(testInfo, name, 'pdf', pdf)
  return readPdf(pdf)
}

// ---- DOCX -------------------------------------------------------------------------------------

interface Docx {
  document: string
  headers: string[]
  /** Text of each paragraph of document.xml, in order (a tab as \t, a line break as \n). */
  paragraphs: { text: string; style: string | null; sectionBreak: boolean }[]
}

function readDocx(bytes: Uint8Array): Docx {
  const zip = unzipSync(bytes)
  const document = strFromU8(zip['word/document.xml'])
  const headers = Object.keys(zip)
    .filter((k) => /^word\/header\d*\.xml$/.test(k))
    .sort()
    .map((k) => strFromU8(zip[k]))
  const paragraphs = [...document.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)].map(([p]) => ({
    text: [...p.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>|<w:(tab|br)\/>/g)].map((m) => m[1] ?? (m[2] === 'tab' ? '\t' : '\n')).join(''),
    style: p.match(/<w:pStyle w:val="([^"]+)"/)?.[1] ?? null,
    sectionBreak: p.includes('<w:sectPr'),
  }))
  return { document, headers, paragraphs }
}

/** Header text with the PAGE field: "Waight / The Long Night / {PAGE}". */
function headerText(xml: string): string {
  let out = ''
  for (const m of xml.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>|<w:instrText[^>]*>([^<]*)<\/w:instrText>|<w:fldSimple w:instr="([^"]+)"/g)) {
    out += m[1] ?? `{${(m[2] ?? m[3]).trim()}}`
  }
  return out
}

// ---- PDF --------------------------------------------------------------------------------------

/** The body pages' running header, the first line of the page, top right. */
const pdfHeader = (page: PdfPage) => page.lines[0].text

/**
 * Pages that open a chapter: the first text line under the header sits a third of the text area down
 * (72 pt margin + 216 pt drop on Letter), not at the top of the text area.
 */
function chapterOpenings(pdf: ReadPdf): { page: number; first: string }[] {
  return pdf.pages.slice(1).flatMap((p) => {
    const body = p.lines.filter((l) => p.height - l.y > 72)
    const first = body[0]
    return first && p.height - first.y > 72 + 216 ? [{ page: p.number, first: first.text }] : []
  })
}

// ---- the wizard ----------------------------------------------------------------------------------

async function openWizard(page: Page) {
  await editor(page).focus()
  await page.keyboard.press('ControlOrMeta+Shift+X')
  await expect(wizard(page)).toBeVisible()
}

async function goTo(page: Page, step: 'title' | 'format' | 'checks' | 'export') {
  await ctl(page, `export.step.${step}`).click()
  await expect(ctl(page, `export.step.${step}`)).toHaveAttribute('aria-current', 'step')
}

/** Close the wizard with its X (an Escape may first close a tooltip the pointer left open). */
async function closeWizard(page: Page) {
  await ctl(page, 'export.close').click()
  await expect(wizard(page)).toHaveCount(0)
}

const FOLDER = '/projects/Night'
const TITLE = 'The Long Night'
const DOCX = '/exports/Waight_THE_LONG_NIGHT_manuscript.docx'
const PDF = '/exports/Waight_THE_LONG_NIGHT_manuscript.pdf'

async function seedFeatureProject(page: Page) {
  await seedPreferences(page, PROFILE)
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
  await expect(saveStatus(page)).toHaveText(`${TITLE}: All changes saved`)
  await waitForLayout(page)
}

// ---- 1. Navigation pane and live counts on the 100k-word book ------------------------------------

test('the 100k-word book: the Navigation Pane jumps to chapters, and the word and page counts follow typing live', { tag: BOTH_MODES }, async ({ page }, testInfo) => {
  test.setTimeout(300_000)
  const fx = buildPaginationFixture()
  await page.setViewportSize({ width: 1400, height: 900 })
  await launch(page)
  await seedProject(page, '/projects/Hundred', 'Hundred', fx.doc)
  await openRecent(page, '/projects/Hundred')
  await expect(saveStatus(page)).toHaveText('Hundred: All changes saved', { timeout: 60_000 })
  await waitForLayout(page)
  expect(projectNavigation(testInfo) === 'book').toBe(await page.evaluate(() => !!document.querySelector('.nv-desk[data-navigation="book"]')))
  await expect(page.getByTestId('word-count')).toHaveText('100,000 words', { timeout: 30_000 })

  // The pane, by its shortcut: every chapter, the total of the book.
  await page.keyboard.press('ControlOrMeta+Shift+O')
  await expect(pane(page)).toBeVisible()
  await expect(page.getByRole('treeitem')).toHaveCount(fx.chapters, { timeout: 30_000 })
  const pages0 = (await layout(page)).pageCount
  await expect(page.getByTestId('outline-total')).toContainText(`100,000 words`)
  await expect(page.getByTestId('outline-total')).toContainText(`${pages0} pages`)

  /** A jump: the caret at the chapter's start, its page on the spread shown (Book) / in view (Scroll), focus in the manuscript. */
  const landed = async (c: number) => {
    await turnSettled(page)
    // The chapter's title block in the document as it is now (typing below adds paragraphs).
    const index = await page.evaluate((k) => {
      const doc = window.__nvE2E.docJSON() as { content: { type: string }[] }
      return doc.content.map((n, i) => (n.type === 'heading' ? i : -1)).filter((i) => i >= 0)[k]
    }, c)
    const at = (await blockPos(page, index)) + 1
    await expect.poll(() => caret(page), { message: `caret at chapter ${c + 1}` }).toBe(at)
    await expect(editor(page)).toBeFocused()
    await expect
      .poll(async () => {
        const l = await layout(page)
        const i = l.pages.findIndex((pg) => !pg.isBlank && pg.from <= at && at < pg.to)
        return i >= l.visibleSpread.first && i <= l.visibleSpread.last
      }, { message: `chapter ${c + 1}'s page in view` })
      .toBe(true)
    await expect(row(page, `ch:${c}`)).toHaveAttribute('aria-selected', 'true')
  }
  // A click on chapter 17, then 5; then from the keyboard: the shortcut focuses the current row, End
  // and Enter go to the last chapter; Home and Enter to the first.
  await row(page, 'ch:16').click()
  await landed(16)
  await row(page, 'ch:4').click()
  await landed(4)
  await page.keyboard.press('ControlOrMeta+Shift+O') // closes it
  await expect(pane(page)).toBeHidden()
  await page.keyboard.press('ControlOrMeta+Shift+O')
  await expect(row(page, 'ch:4')).toBeFocused()
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await landed(fx.chapters - 1)
  await page.keyboard.press('ControlOrMeta+Shift+O')
  await expect(pane(page)).toBeHidden()
  await page.keyboard.press('ControlOrMeta+Shift+O')
  await expect(row(page, `ch:${fx.chapters - 1}`)).toBeFocused()
  await page.keyboard.press('Home')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await landed(2)

  // Type at chapter 3's start (after its title): its row, the pane total and the status bar follow.
  const wordsOf = async (key: string) => num((await rowCounts(page, key).textContent())!.match(/^([\d,]+) words?/)![1])
  const ch3 = await wordsOf('ch:2')
  await lineEnd(page) // (End scrolls on macOS: the helper uses Cmd+Right there)
  await page.keyboard.type(' and seven more words typed here')
  await expect(page.getByTestId('word-count')).toHaveText('100,006 words')
  await expect.poll(() => wordsOf('ch:2')).toBe(ch3 + 6)
  await expect(page.getByTestId('outline-total')).toContainText('100,006 words')
  // A long passage (one paste-like input): a page more; the page counts follow too.
  await page.keyboard.press('Enter')
  const passage = Array.from({ length: 600 }, (_, i) => ['lantern', 'river', 'stone'][i % 3]).join(' ') + '.'
  await page.keyboard.insertText(passage)
  await waitForLayout(page)
  await expect(page.getByTestId('word-count')).toHaveText('100,606 words')
  await expect.poll(async () => (await layout(page)).pageCount).toBeGreaterThan(pages0)
  const pages1 = (await layout(page)).pageCount
  await expect(page.getByTestId('outline-total')).toContainText(`${pages1} pages`)
  await expect(page.getByTestId('page-indicator')).toContainText(`of ${pages1}`)
  await expect(rowCounts(page, `ch:${fx.chapters - 1}`)).toContainText(new RegExp(`–${pages1}$`))
  await expect.poll(() => wordsOf('ch:2')).toBe(ch3 + 606)
  // And a jump after the edit still lands on its chapter.
  await row(page, 'ch:20').click()
  await landed(20)
})

// ---- 2. The feature fixture: wizard, outputs, persistence, Export Again ---------------------------

test('the feature fixture: the wizard (a blocking check fixed), DOCX and PDF checked; settings survive save, reopen and recovery; Export Again', async ({ page: first, context }, testInfo) => {
  test.setTimeout(300_000)
  let page = first
  await page.setViewportSize({ width: 1400, height: 900 })
  await seedFeatureProject(page)

  // 1. Title page: prefilled from the author profile; the genre for the length check. A blank name
  // and contact block make two blocking checks.
  await openWizard(page)
  await expect(ctl(page, 'export.title')).toHaveValue(TITLE)
  await expect(ctl(page, 'export.legalName')).toHaveValue('Ann Waight')
  await ctl(page, 'export.genre').selectOption('thriller')
  await ctl(page, 'export.legalName').fill('')
  await ctl(page, 'export.email').fill('')
  await ctl(page, 'export.address').fill('')
  // 2. Formatting (Alt+N, from inside the wizard): Standard on Letter.
  await pressAccessKey(page, 'KeyN')
  await expect(ctl(page, 'export.step.format')).toHaveAttribute('aria-current', 'step')
  await expect(ctl(page, 'export.preset.standard')).toBeChecked()
  await expect(ctl(page, 'export.paper')).toHaveValue('letter')
  // 3. Checks: name and contact block the export.
  await pressAccessKey(page, 'KeyN')
  await expect(check(page, 'name')).toHaveAttribute('data-severity', 'blocking')
  await expect(check(page, 'contact')).toHaveAttribute('data-severity', 'blocking')
  await goTo(page, 'export')
  await expect(ctl(page, 'export.start')).toHaveAttribute('aria-disabled', 'true')
  // Fix: back to the field, focused; typed in; the checks pass.
  await goTo(page, 'checks')
  await check(page, 'contact').locator('[data-control-id="export.check.fix"]').first().click()
  await expect(ctl(page, 'export.legalName')).toBeFocused()
  await page.keyboard.type('Ann Waight')
  await ctl(page, 'export.email').fill('ann@example.com')
  await ctl(page, 'export.address').fill('1 Quay Street\nPort Town')
  await goTo(page, 'checks')
  await expect(check(page, 'name')).toHaveAttribute('data-severity', 'pass')
  await expect(check(page, 'contact')).toHaveAttribute('data-severity', 'pass')
  await expect(check(page, 'word-count')).toHaveAttribute('data-severity', 'warning')
  // 4. Export (Alt+E): DOCX and PDF.
  await pressAccessKey(page, 'KeyN')
  await expect(ctl(page, 'export.start')).not.toHaveAttribute('aria-disabled', 'true')
  await pressAccessKey(page, 'KeyE')
  await expect(wizard(page).getByTestId('export-done')).toBeVisible()
  expect(await written(page)).toEqual([DOCX, PDF])

  // The DOCX: title page, running header with a PAGE field, a new section (page) per chapter.
  const docxBytes = await exported(page, DOCX)
  keep(testInfo, 'feature', 'docx', docxBytes)
  const docx = readDocx(docxBytes)
  const texts = docx.paragraphs.map((p) => p.text)
  // Contact block upper left, the word count on its first line at the right tab; title; by-line.
  expect(texts.slice(0, 6)).toEqual([expect.stringMatching(/^Ann Waight\tabout [\d,]+ words$/), '1 Quay Street', 'Port Town', 'ann@example.com', TITLE, 'A Novel by Ann Waight'])
  expect(docx.paragraphs[5].sectionBreak, 'the title page is a section of its own').toBe(true)
  const docxCount = texts[0].split('\t')[1]
  expect(docx.headers.map(headerText)).toContain('Waight / The Long Night / {PAGE}')
  expect(docx.document).not.toMatch(/<w:(ins|del|rPrChange|pPrChange|commentRangeStart)\b/)
  // Every chapter (Heading 1: number and title, or an empty one for the untitled chapter) starts a new
  // section, so a new page; the part title is a page of its own.
  const chapters = docx.paragraphs.map((p, i) => ({ ...p, i })).filter((p) => p.style === 'Heading1')
  expect(chapters.map((c) => c.text)).toEqual(['Chapter One\nThe Arrival', 'The Storm', '', 'Chapter Three\nEpilogue'])
  for (const c of chapters) expect(docx.paragraphs[c.i - 1].sectionBreak, `${c.text}: starts a new section`).toBe(true)
  expect(docx.paragraphs.find((p) => p.style === 'PartTitle')).toMatchObject({ text: 'Part Two', sectionBreak: true })
  // (A section with no w:type starts on the next page: the OOXML default.)
  expect(docx.document).not.toContain('w:type w:val="continuous"')

  // The PDF (the real Typst render of the app's request): title page, headers numbered from 1 on the
  // first text page, every chapter at a new page dropped a third down.
  const pdf = await realPdf(page, testInfo, 'feature')
  if (pdf) {
    const [title, ...body] = pdf.pages
    expect(title.lines.map((l) => l.text)).toEqual([
      expect.stringMatching(/^Ann Waight\s*about [\d,]+ words$/),
      '1 Quay Street',
      'Port Town',
      'ann@example.com',
      TITLE,
      'A Novel by Ann Waight',
    ])
    expect(title.text).not.toContain('Waight / ')
    body.forEach((p, i) => expect(pdfHeader(p), `page ${p.number}`).toBe(`Waight / The Long Night / ${i + 1}`))
    const openings = chapterOpenings(pdf)
    // The chapters (number line first), the part title, and the untitled chapter's first line.
    expect(openings.map((o) => o.first)).toEqual(['Chapter One', 'The Storm', 'Part Two', 'Nothing has a name here.', 'Chapter Three'])
    expect(openings.map((o) => o.page)).toEqual([...openings.map((o) => o.page)].sort((a, b) => a - b))
    expect(pdf.info.Title).toBe(TITLE)
    expect(pdf.info.Author).toBe('Ann Waight')
    // The DOCX and the PDF state the same word count on the title page.
    expect(title.lines[0].text.match(/about [\d,]+ words/)![0]).toBe(docxCount)
  }
  await ctl(page, 'export.finish').click()
  await expect(wizard(page)).toHaveCount(0)

  // Export Manuscript Again in this session: the same two files, after confirming, no wizard.
  await page.evaluate(() => window.__nvE2E.exports.written.clear())
  await editor(page).focus()
  await page.keyboard.press('ControlOrMeta+Alt+Shift+X')
  await expect(nativeDialog(page)).toContainText('Replace Waight_THE_LONG_NIGHT_manuscript.docx and Waight_THE_LONG_NIGHT_manuscript.pdf')
  await nativeDialog(page).getByRole('button', { name: 'Replace' }).click()
  await expect(page.getByTestId('export-status')).toContainText('Exported Waight_THE_LONG_NIGHT_manuscript.docx')
  await expect(wizard(page)).toHaveCount(0)
  expect(await written(page)).toEqual([DOCX, PDF])

  // Settings: the Classic preset, a scene break; saved, then reopened.
  await openWizard(page)
  await goTo(page, 'format')
  await ctl(page, 'export.preset.classic').check()
  await ctl(page, 'export.sceneBreak').fill('* * *')
  await closeWizard(page)
  await saveProject(page, TITLE)
  const saved = JSON.parse((await readFile(page, `${FOLDER}/export.json`))!)
  expect(saved.settings).toMatchObject({ preset: 'classic', sceneBreak: '* * *', checks: { genre: 'thriller' } })
  expect(saved.contact).toBeUndefined()
  page = await reopenProject(context as BrowserContext, page, FOLDER, TITLE)
  await openWizard(page)
  await expect(ctl(page, 'export.genre')).toHaveValue('thriller')
  await goTo(page, 'format')
  await expect(ctl(page, 'export.preset.classic')).toBeChecked()
  await expect(ctl(page, 'export.sceneBreak')).toHaveValue('* * *')
  // Unsaved, then a crash: A4 paper, restored by recovery.
  await ctl(page, 'export.paper').selectOption('a4')
  await closeWizard(page)
  page = await crashAndRestore(context, page, TITLE)
  await openWizard(page)
  await goTo(page, 'format')
  await expect(ctl(page, 'export.paper')).toHaveValue('a4')
  await expect(ctl(page, 'export.preset.classic')).toBeChecked()
  await closeWizard(page)

  // Export Manuscript Again after the restart: the Save dialogs come back (the session's grants are
  // gone); the files are the Classic A4 manuscript.
  await page.evaluate(() => window.__nvE2E.exports.written.clear())
  await editor(page).focus()
  await page.keyboard.press('ControlOrMeta+Alt+Shift+X')
  await expect(page.getByTestId('export-status')).toContainText('Exported Waight_THE_LONG_NIGHT_manuscript.docx', { timeout: 30_000 })
  expect(await written(page)).toEqual([DOCX, PDF])
  // (Where the dialog opens after a restart is Rust's export-folders.json: src-tauri tests and the
  // fake core's unit tests cover it; the e2e fake core does not keep it across a relaunch.)
  expect(await page.evaluate(() => window.__nvE2E.exports.dialogs.map((d) => d.kind))).toEqual(['docx', 'pdf'])
  const again = readDocx(await exported(page, DOCX))
  expect(again.document).toMatch(/<w:pgSz w:w="11906" w:h="16838"/) // A4
  // Classic: underline for italics, two spaces after a sentence.
  expect(again.document).toContain('<w:u w:val="single"/>')
  expect(again.document).not.toContain('<w:i/>')
  expect(again.document).toContain('>  The rain fell <')
  expect(again.paragraphs.some((p) => p.text === '* * *')).toBe(true)
  const pdfAgain = await realPdf(page, testInfo, 'feature-classic-a4')
  if (pdfAgain) {
    expect(pdfAgain.pages[0].width).toBeCloseTo(595.28, 0)
    expect(pdfAgain.pages.some((p) => p.lines.some((l) => l.text === '* * *'))).toBe(true)
    expect(pdfAgain.fonts.every((f) => f.startsWith('LiberationMono'))).toBe(true)
  }
})

// ---- 3. The 100k-word book to DOCX and PDF --------------------------------------------------------

test('the 100k-word book exports to DOCX and PDF: every chapter on a new page, headers and page numbers throughout', async ({ page }, testInfo) => {
  test.setTimeout(300_000)
  const fx = buildPaginationFixture()
  await seedPreferences(page, PROFILE)
  await page.setViewportSize({ width: 1400, height: 900 })
  await launch(page)
  await seedProject(page, '/projects/Hundred', 'Hundred', fx.doc)
  await openRecent(page, '/projects/Hundred')
  await expect(saveStatus(page)).toHaveText('Hundred: All changes saved', { timeout: 60_000 })
  await waitForLayout(page)
  await openWizard(page)
  await expect(wizard(page).getByTestId('wizard-wordcount')).toContainText('about 100,000 words')
  await goTo(page, 'checks')
  await expect(wizard(page).locator('[data-severity="blocking"]')).toHaveCount(0)
  await goTo(page, 'export')
  await ctl(page, 'export.start').click()
  await expect(wizard(page).getByTestId('export-done')).toBeVisible({ timeout: 60_000 })
  const paths = await written(page)
  expect(paths).toHaveLength(2)

  const docxBytes = await exported(page, paths.find((p) => p.endsWith('.docx'))!)
  keep(testInfo, 'hundred', 'docx', docxBytes)
  const docx = readDocx(docxBytes)
  const titles = (fx.doc.content as { type: string; content: { text: string }[] }[]).filter((n) => n.type === 'heading').map((n) => n.content[0].text)
  expect(titles).toHaveLength(fx.chapters)
  const at = titles.map((t) => docx.paragraphs.findIndex((p) => p.text === t))
  expect(at.every((i) => i > 0)).toBe(true)
  expect(at).toEqual([...at].sort((a, b) => a - b))
  // Every chapter starts a new section (page), the first one too (the title page is a section of its
  // own), and the header is "Waight / Hundred / {PAGE}".
  for (const i of at) expect(docx.paragraphs[i - 1].sectionBreak).toBe(true)
  expect(docx.headers.map(headerText)).toContain('Waight / Hundred / {PAGE}')
  expect(docx.paragraphs[0].text).toBe('Ann Waight\tabout 100,000 words')

  const pdf = await realPdf(page, testInfo, 'hundred')
  if (pdf) {
    const [title, ...body] = pdf.pages
    expect(title.text).toContain('about 100,000 words')
    expect(body.length).toBeGreaterThan(300)
    body.forEach((p, i) => expect(pdfHeader(p), `page ${p.number}`).toBe(`Waight / Hundred / ${i + 1}`))
    const openings = chapterOpenings(pdf)
    expect(openings.map((o) => o.first)).toEqual(titles)
  }
})

// ---- 4. Offline -----------------------------------------------------------------------------------

const MIME: Record<string, string> = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.json': 'application/json', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.wasm': 'application/wasm' }

test('offline: with the network disabled, DOCX and PDF export, and nothing is requested from outside', async ({ page, context }, testInfo) => {
  test.setTimeout(180_000)
  // The network is off for the whole context (page and workers). The app's own files come from disk,
  // as the installed app's do (Tauri's asset protocol): every request is answered from dist-e2e/ by
  // this handler, or refused and recorded when it is not for the app itself.
  const outbound: string[] = []
  const appFiles = join(ROOT, 'dist-e2e')
  await context.setOffline(true)
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    if (url.origin !== new URL(testInfo.project.use.baseURL!).origin) {
      outbound.push(url.href)
      return route.abort('internetdisconnected')
    }
    const file = join(appFiles, decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname))
    if (!file.startsWith(appFiles) || !existsSync(file)) return route.fulfill({ status: 404, body: '' })
    return route.fulfill({ status: 200, body: readFileSync(file), contentType: MIME[extname(file)] ?? 'application/octet-stream' })
  })
  context.on('request', (r) => {
    const url = r.url()
    if (!url.startsWith(testInfo.project.use.baseURL!) && !/^(data|blob):/.test(url)) outbound.push(url)
  })
  await page.setViewportSize({ width: 1400, height: 900 })
  await seedFeatureProject(page)
  await openWizard(page)
  await goTo(page, 'export')
  await ctl(page, 'export.start').click()
  await expect(wizard(page).getByTestId('export-done')).toBeVisible({ timeout: 60_000 })
  expect(await written(page)).toEqual([DOCX, PDF])
  expect(readDocx(await exported(page, DOCX)).paragraphs.some((p) => p.text === 'The Storm')).toBe(true)
  // The PDF: the sidecar run as Rust runs it (empty package folders, a dead proxy, bundled fonts only;
  // src-tauri/src/export/tests.rs also proves it with the network blocked).
  const pdf = await realPdf(page, testInfo, 'offline')
  if (pdf) expect(pdf.pages[0].text).toContain(TITLE)
  expect(outbound).toEqual([])
})
