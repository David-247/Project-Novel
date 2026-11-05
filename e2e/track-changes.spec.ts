import { expect, test, type Page } from '@playwright/test'
import { buildPaginationFixture } from './fixtures/pagination-manuscript'
import { editor, launch, newProject, openRecent, readFile, saveStatus, seedProject, waitForLayout } from './helpers'

/**
 * Track changes (docs/track-changes.md): recording through the toolbar and Mod-Shift-e, the four
 * markup views, persistence, and the pagination contract: hidden text takes no space, so a view's
 * page breaks equal those of the manuscript with the changes accepted (No Markup) or rejected
 * (Original).
 */

const track = (page: Page) => page.locator('[data-control-id="review.track"]')
const markup = (page: Page) => page.locator('[data-control-id="review.markup"]')

async function chooseView(page: Page, label: 'All Markup' | 'Simple Markup' | 'No Markup' | 'Original') {
  await markup(page).click()
  await page.getByRole('menuitemradio', { name: label }).click()
  await expect(markup(page)).toContainText(label)
  await waitForLayout(page)
}

type Json = Record<string, unknown>
const stamp = (id: string) => ({ id, author: 'Ann', date: '2026-01-01T00:00:00.000Z' })
const mark = (type: 'insertion' | 'deletion', id: string) => ({ type, attrs: { ...stamp(id), authorColor: null } })

test('recording: the toggle and Mod-Shift-e, typed and deleted text, undo; saved and reopened', async ({ page, context }) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  await launch(page)
  await newProject(page, '/projects/Tracked')
  await editor(page).click()
  await page.keyboard.type('Hello there')
  await expect(track(page)).toHaveAttribute('aria-pressed', 'false')
  await page.keyboard.press('ControlOrMeta+Shift+E')
  await expect(track(page)).toHaveAttribute('aria-pressed', 'true')

  // Backspace over existing text: struck through, still there; typing goes in as an insertion.
  await page.keyboard.press('Backspace')
  await page.keyboard.press('Backspace')
  await page.keyboard.press('Backspace')
  await page.keyboard.press('Backspace')
  await page.keyboard.press('Backspace')
  await expect(editor(page).locator('.nv-del')).toHaveText('there')
  await page.keyboard.type('world')
  await expect(editor(page).locator('.nv-ins')).toHaveText('world')
  await expect(editor(page).locator('p')).toHaveText('Hello worldthere')
  expect(await page.evaluate(() => window.__nvE2E.countChanges())).toBe(2)
  const insStyle = await editor(page).locator('.nv-ins').evaluate((el) => getComputedStyle(el).textDecorationLine)
  expect(insStyle).toContain('underline')
  const delStyle = await editor(page).locator('.nv-del').evaluate((el) => getComputedStyle(el).textDecorationLine)
  expect(delStyle).toContain('line-through')

  // One undo step per edit (the typing is one step, the deletions another), marks and text restored.
  await page.keyboard.press('ControlOrMeta+z')
  await expect(editor(page).locator('.nv-ins')).toHaveCount(0)
  await page.keyboard.press('ControlOrMeta+Shift+z')
  await expect(editor(page).locator('.nv-ins')).toHaveText('world')

  // The toolbar toggle turns recording off; existing marks stay.
  await track(page).click()
  await expect(track(page)).toHaveAttribute('aria-pressed', 'false')
  await track(page).click()
  await expect(track(page)).toHaveAttribute('aria-pressed', 'true')

  await editor(page).click()
  await page.keyboard.press('ControlOrMeta+s')
  await expect(saveStatus(page)).toHaveText('Tracked: Saved')
  const book = JSON.parse((await readFile(page, '/projects/Tracked/book.json'))!)
  expect(book.trackChanges).toBe(true)
  const saved = JSON.parse((await readFile(page, '/projects/Tracked/manuscript.json'))!)
  const marks = (saved.content[0].content as Json[]).map((n) => ((n.marks as Json[] | undefined) ?? []).map((m) => m.type).join())
  expect(marks).toEqual(['', 'insertion', 'deletion'])

  await page.close()
  const again = await context.newPage()
  await launch(again)
  await openRecent(again, '/projects/Tracked')
  await expect(saveStatus(again)).toHaveText('Tracked: All changes saved')
  await expect(track(again)).toHaveAttribute('aria-pressed', 'true')
  await expect(editor(again).locator('.nv-del')).toHaveText('there')
  await expect(editor(again).locator('.nv-ins')).toHaveText('world')
})

test('IME composition while tracking is one insertion', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Input.imeSetComposition is a Chromium DevTools protocol call')
  await launch(page)
  await newProject(page, '/projects/Ime')
  await editor(page).click()
  await page.keyboard.type('Word ')
  await page.evaluate(() => window.__nvE2E.setTracking(true))
  const cdp = await page.context().newCDPSession(page)
  const compose = (text: string) => cdp.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length })
  await compose('k')
  await compose('か')
  await compose('かんじ')
  await cdp.send('Input.insertText', { text: '漢字' })
  await expect(editor(page).locator('p')).toHaveText('Word 漢字')
  await expect(editor(page).locator('.nv-ins')).toHaveText('漢字')
  expect(await page.evaluate(() => window.__nvE2E.countChanges())).toBe(1)
})

test('markup views: what each shows, footnote numbers and Find follow the view', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  await launch(page)
  const doc = {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Keep ' },
          { type: 'text', text: 'zebra', marks: [mark('deletion', 'd1')] },
          { type: 'text', text: 'quail', marks: [mark('insertion', 'i1')] },
          { type: 'footnote', marks: [mark('deletion', 'd2')], content: [{ type: 'text', text: 'Deleted note.' }] },
          { type: 'text', text: ' end' },
          { type: 'footnote', content: [{ type: 'text', text: 'Kept note.' }] },
        ],
      },
      { type: 'paragraph', attrs: { trackedDelete: stamp('d3') }, content: [{ type: 'text', text: 'Deleted paragraph.', marks: [mark('deletion', 'd3')] }] },
      { type: 'paragraph', attrs: { trackedInsert: stamp('i2') }, content: [{ type: 'text', text: 'Inserted paragraph.', marks: [mark('insertion', 'i2')] }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Last.' }] },
    ],
  }
  await seedProject(page, '/projects/Views', 'Views', doc)
  await openRecent(page, '/projects/Views')
  await expect(saveStatus(page)).toHaveText('Views: All changes saved')
  await waitForLayout(page)
  const ed = editor(page)
  const shown = () =>
    ed.evaluate((root) =>
      Array.from(root.querySelectorAll(':scope > p'))
        .filter((p) => (p as HTMLElement).offsetHeight > 0)
        .map((p) => (p as HTMLElement).innerText.replace(/\s+/g, ' ').trim()),
    )
  const labels = () => ed.locator('[data-footnote-ref]').evaluateAll((els) => els.filter((e) => (e as HTMLElement).offsetParent).map((e) => e.getAttribute('data-fn-num')))

  await chooseView(page, 'All Markup')
  expect(await shown()).toEqual(['Keep zebraquail end', 'Deleted paragraph.', 'Inserted paragraph.', 'Last.'])
  expect(await labels()).toEqual(['1', '2'])

  await chooseView(page, 'No Markup')
  expect(await shown()).toEqual(['Keep quail end', 'Inserted paragraph.', 'Last.'])
  expect(await labels()).toEqual(['1'])
  expect(await ed.locator('.nv-ins').first().evaluate((el) => getComputedStyle(el).textDecorationLine)).toBe('none')
  expect(await page.evaluate(() => window.__nvE2E.footnotes().map((f) => f.text))).toEqual(['Kept note.'])

  await chooseView(page, 'Simple Markup')
  expect(await shown()).toEqual(['Keep quail end', 'Inserted paragraph.', 'Last.'])
  // The change bar beside a changed line.
  expect(await ed.locator('.nv-ins').first().evaluate((el) => getComputedStyle(el, '::before').position)).toBe('absolute')

  await chooseView(page, 'Original')
  expect(await shown()).toEqual(['Keep zebra end', 'Deleted paragraph.', 'Last.'])
  expect(await labels()).toEqual(['1', '2'])

  // Find: deleted text is not found in No Markup, found in All Markup.
  await chooseView(page, 'No Markup')
  await ed.click()
  await page.keyboard.press('ControlOrMeta+f')
  const find = page.getByRole('region', { name: 'Find and replace' })
  await find.getByRole('textbox', { name: 'Find' }).fill('zebra')
  await expect(page.getByTestId('find-status')).toHaveText(/no results|0 of 0|not found/i)
  await page.keyboard.press('Escape')
  await chooseView(page, 'All Markup')
  await ed.click()
  await page.keyboard.press('ControlOrMeta+f')
  await find.getByRole('textbox', { name: 'Find' }).fill('zebra')
  await expect(page.getByTestId('find-status')).toHaveText(/1 of 1/)
})

/**
 * The fixture manuscript with tracked changes of every inline and block kind, deterministic: inserted
 * and deleted words (of different lengths, so line breaks move), inserted paragraphs and deleted
 * paragraphs.
 */
function trackedFixture() {
  const fx = buildPaginationFixture({ words: 24_000, chapters: 8 })
  const content: Json[] = []
  let n = 0
  let changes = 0
  for (const block of fx.doc.content as Json[]) {
    if (block.type !== 'paragraph') {
      content.push(block)
      continue
    }
    n++
    const runs = block.content as Json[]
    const first = runs[0] as { text: string }
    if (n % 3 === 0 && first.text.length > 40) {
      const cut = first.text.indexOf(' ', 20)
      const word = first.text.slice(cut + 1, first.text.indexOf(' ', cut + 1) + 1)
      const rest = first.text.slice(cut + 1 + word.length)
      content.push({
        ...block,
        content: [
          { type: 'text', text: first.text.slice(0, cut + 1) },
          { type: 'text', text: word, marks: [mark('deletion', `d${n}`)] },
          { type: 'text', text: 'inserted words here ', marks: [mark('insertion', `i${n}`)] },
          { type: 'text', text: rest },
          ...runs.slice(1),
        ],
      })
      changes += 2
    } else if (n % 23 === 0) {
      content.push({
        type: 'paragraph',
        attrs: { trackedDelete: stamp(`p${n}`) },
        content: runs.map((r) => ({ ...r, marks: [...((r.marks as Json[]) ?? []), mark('deletion', `p${n}`)] })),
      })
      changes++
    } else content.push(block)
    if (n % 17 === 0) {
      content.push({
        type: 'paragraph',
        attrs: { trackedInsert: stamp(`n${n}`) },
        content: [{ type: 'text', text: 'A whole new paragraph inserted here, long enough to take a few lines on the page. '.repeat(3).trim(), marks: [mark('insertion', `n${n}`)] }],
      })
      changes++
    }
  }
  return { doc: { type: 'doc', content }, changes }
}

async function layoutOf(page: Page) {
  await waitForLayout(page)
  const l = await page.evaluate(() => window.__nvE2E.layout())
  return {
    pageCount: l.pageCount,
    chapters: l.pages.map((p) => p.chapterIndex),
    starts: await page.evaluate(() => window.__nvE2E.pageStarts()),
  }
}

test('hidden text takes no space: No Markup pages = changes accepted, Original pages = changes rejected', async ({ page }) => {
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 1400, height: 900 })
  await launch(page)
  const { doc, changes } = trackedFixture()
  await seedProject(page, '/projects/Pages', 'Pages', doc)
  await openRecent(page, '/projects/Pages')
  await expect(saveStatus(page)).toHaveText('Pages: All changes saved', { timeout: 60_000 })
  expect(await page.evaluate(() => window.__nvE2E.countChanges())).toBe(changes)
  // Chapters open on a new page (as the style sheet does), so chapter openings are compared too.
  await page.evaluate(() => window.__nvE2E.breakBeforeBlocks({ type: 'heading', level: 1 }, 'page'))

  const all = await layoutOf(page)
  await page.evaluate(() => window.__nvE2E.setMarkupView('none'))
  const final = await layoutOf(page)
  expect(final.pageCount).toBeLessThan(all.pageCount)
  await page.evaluate(() => {
    window.__nvE2E.resolveAllChanges('accept')
    window.__nvE2E.setMarkupView('all')
  })
  const accepted = await layoutOf(page)
  expect(await page.evaluate(() => window.__nvE2E.countChanges())).toBe(0)
  expect(final.pageCount).toBe(accepted.pageCount)
  expect(final.chapters).toEqual(accepted.chapters)
  expect(final.starts).toEqual(accepted.starts)

  await page.evaluate((d) => window.__nvE2E.setDoc(d), doc)
  await page.evaluate(() => window.__nvE2E.setMarkupView('original'))
  const original = await layoutOf(page)
  await page.evaluate(() => {
    window.__nvE2E.resolveAllChanges('reject')
    window.__nvE2E.setMarkupView('all')
  })
  const rejected = await layoutOf(page)
  expect(original.pageCount).toBe(rejected.pageCount)
  expect(original.chapters).toEqual(rejected.chapters)
  expect(original.starts).toEqual(rejected.starts)

  // Simple Markup hides the same text as No Markup: same pages.
  await page.evaluate((d) => window.__nvE2E.setDoc(d), doc)
  await page.evaluate(() => window.__nvE2E.setMarkupView('simple'))
  const simple = await layoutOf(page)
  expect(simple.pageCount).toBe(accepted.pageCount)
  expect(simple.starts).toEqual(accepted.starts)
})
