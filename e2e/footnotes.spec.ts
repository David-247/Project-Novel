import { expect, test, type Page } from '@playwright/test'
import { docEnd, docStart, editor, launch, lineEnd, newProject, openRecent, readFile, saveStatus, waitForLayout } from './helpers'

/**
 * Footnotes (Phase 2): the reference in the text, the note at the bottom of the page it falls on,
 * continuation, no overlap with body text, the pathological near-the-bottom case, persistence.
 */

const WORDS = 'night river quiet lantern stone window garden letter morning shadow silver harbor whisper meadow'.split(' ')
function paragraphs(count: number, words = 100) {
  let n = 0
  return Array.from({ length: count }, (_, i) => {
    const len = Math.max(8, Math.round(words * (0.4 + ((i * 37) % 13) / 10)))
    return Array.from({ length: len }, () => WORDS[(n++ * 5) % WORDS.length]).join(' ')
  })
}
const words = (n: number) => Array.from({ length: n }, (_, i) => WORDS[(i * 3) % WORDS.length]).join(' ')

async function pasteInto(page: Page, blocks: string[]) {
  await editor(page).click()
  await editor(page).evaluate((el, text) => {
    const data = new DataTransfer()
    data.setData('text/plain', text)
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  }, blocks.join('\n\n'))
  await waitForLayout(page)
}

async function setup(page: Page, count = 12) {
  await page.setViewportSize({ width: 1400, height: 900 })
  await launch(page)
  await pasteInto(page, paragraphs(count))
  await page.locator('[data-control-id="pagination.zoom"]').selectOption('100')
  // Caret (and scroll) back at the top: the pages under test are in view.
  await editor(page).focus()
  await docStart(page)
  await waitForLayout(page)
}

/** Escape closes an open tooltip first (app-wide behaviour), then the dialog. */
async function escapeDialog(page: Page, name: string) {
  const dialog = page.getByRole('dialog', { name })
  await page.keyboard.press('Escape')
  try {
    await expect(dialog).toHaveCount(0, { timeout: 1000 })
  } catch {
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
  }
}

const layout = (page: Page) => page.evaluate(() => window.__nvE2E.layout())
const areas = (page: Page) => page.evaluate(() => window.__nvE2E.footnoteAreas())

/** Page index (frame) whose box contains the painted reference `k` (0-based, document order). */
async function pageOfRef(page: Page, k: number): Promise<number> {
  return page.evaluate((i) => {
    const ref = document.querySelectorAll('.ProseMirror [data-footnote-ref]')[i]!.getBoundingClientRect()
    const cx = ref.left + ref.width / 2
    const cy = ref.top + ref.height / 2
    for (const f of Array.from(document.querySelectorAll<HTMLElement>('.nv-frames .nv-page'))) {
      const r = f.getBoundingClientRect()
      if (cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom) return Number(f.dataset.pageIndex)
    }
    return -1
  }, k)
}

/**
 * For page `p`: the top of its footnote area and the bottom of the lowest body text painted on the
 * page (text client rects inside the frame). Body text must end above the area.
 */
async function overlap(page: Page, p: number) {
  return page.evaluate((idx) => {
    const frame = document.querySelector(`.nv-frames .nv-page[data-page-index="${idx}"]`)!.getBoundingClientRect()
    const area = document.querySelector(`.nv-frames .nv-page[data-page-index="${idx}"] .nv-fn-area`)
    const areaTop = area ? area.getBoundingClientRect().top : Infinity
    const r = document.createRange()
    let bottom = -Infinity
    const walker = document.createTreeWalker(document.querySelector('.ProseMirror')!, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      r.selectNodeContents(n)
      for (const rc of Array.from(r.getClientRects())) {
        if (rc.width === 0 || rc.height === 0) continue
        const cx = rc.left + rc.width / 2
        const cy = rc.top + rc.height / 2
        if (cx >= frame.left && cx <= frame.right && cy >= frame.top && cy <= frame.bottom) bottom = Math.max(bottom, rc.bottom)
      }
    }
    return { areaTop, bodyBottom: bottom, hasArea: !!area }
  }, p)
}

async function scrollToPage(page: Page, p: number) {
  await page.locator(`.nv-frames .nv-page[data-page-index="${p}"]`).scrollIntoViewIfNeeded()
  await waitForLayout(page)
}

test('Insert > Footnote: superscript number in the text, the note at the bottom of the same page; Escape returns', async ({ page }) => {
  await setup(page)
  await docStart(page)
  await lineEnd(page)
  await page.locator('[data-control-id="insert.menu"]').click()
  await page.locator('[data-control-id="footnote.insert"]').click()
  const box = page.getByTestId('footnote-editor')
  await expect(box).toBeFocused()
  await page.keyboard.type('A short note.')
  await expect(page.getByTestId('footnote-popover')).toContainText('Footnote 1')
  await page.keyboard.press('Escape')
  await expect(box).toHaveCount(0)
  await expect(editor(page)).toBeFocused()
  // The caret is right after the reference.
  await page.keyboard.type('Z')
  await waitForLayout(page)
  const ref = editor(page).locator('[data-footnote-ref]')
  await expect(ref).toHaveAttribute('data-fn-num', '1')
  expect(await ref.evaluate((el) => el.nextSibling?.textContent?.startsWith('Z'))).toBe(true)
  const notes = await page.evaluate(() => window.__nvE2E.footnotes())
  expect(notes).toEqual([{ pos: expect.any(Number), label: '1', text: 'A short note.' }])

  // The note is drawn at the bottom of the page holding the reference, below its rule.
  const p = await pageOfRef(page, 0)
  expect(p).toBe(0)
  const area = page.locator(`.nv-frames .nv-page[data-page-index="${p}"] .nv-fn-area`)
  await expect(area).toHaveText('1 A short note.')
  await expect(area.locator('.nv-fn-rule')).toHaveCount(1)
  const frame = (await page.locator(`.nv-frames .nv-page[data-page-index="${p}"]`).boundingBox())!
  const a = (await area.boundingBox())!
  // Bottom of the area = bottom of the text block (54 pt bottom margin = 72 px).
  expect(Math.abs(a.y + a.height - (frame.y + frame.height - 72))).toBeLessThan(1.5)
  const o = await overlap(page, p)
  expect(o.bodyBottom).toBeLessThanOrEqual(o.areaTop + 0.5)

  // Editing again: a press on the reference opens it; Done returns.
  await ref.click()
  await expect(box).toBeFocused()
  await page.keyboard.type(' More.')
  await page.locator('[data-control-id="footnote.done"]').click()
  await expect(editor(page)).toBeFocused()
  await expect(area).toHaveText('1 A short note. More.')
  // Undo in the manuscript takes back the note edit (one history).
  await page.keyboard.press('ControlOrMeta+z')
  await expect(area).toHaveText('1 A short note.')
})

test('Mod-Alt-f inserts; numbers follow document order and update live; the selected reference opens with Enter', async ({ page }) => {
  await setup(page)
  // A footnote late on page 0 first.
  const l = await layout(page)
  await page.evaluate((pos) => window.__nvE2E.insertFootnoteAt(pos, 'Second note.'), Math.min(l.pages[0].to - 5, 400))
  await waitForLayout(page)
  await docStart(page)
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ControlOrMeta+Alt+f')
  await expect(page.getByTestId('footnote-editor')).toBeFocused()
  await page.keyboard.type('First note.')
  await page.keyboard.press('Escape')
  await waitForLayout(page)
  await expect(editor(page).locator('[data-footnote-ref]')).toHaveCount(2)
  expect(await editor(page).locator('[data-footnote-ref]').evaluateAll((els) => els.map((e) => e.getAttribute('data-fn-num')))).toEqual(['1', '2'])
  const area = page.locator('.nv-frames .nv-page[data-page-index="0"] .nv-fn-area')
  await expect(area.locator('.nv-fn-note')).toHaveText(['1 First note.', '2 Second note.'])
  // Arrow back onto the reference selects it; Enter opens its note.
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('footnote-editor')).toHaveText('First note.')
  await page.keyboard.press('Escape')
  // Deleting the reference deletes its note, and the rest renumber.
  await page.keyboard.press('Backspace')
  await waitForLayout(page)
  await expect(area.locator('.nv-fn-note')).toHaveText(['1 Second note.'])
  // Footnote options: symbols.
  await page.locator('[data-control-id="footnote.options"]').click()
  await page.locator('[data-control-id="footnote.options.format"]').selectOption('symbols')
  await escapeDialog(page, 'Footnote options')
  await waitForLayout(page)
  await expect(area.locator('.nv-fn-note')).toHaveText(['* Second note.'])
  await expect(editor(page).locator('[data-footnote-ref]')).toHaveAttribute('data-fn-num', '*')
})

test('a long note continues in the footnote area of the next page; body text never overlaps', async ({ page }) => {
  await setup(page)
  await page.evaluate((text) => window.__nvE2E.insertFootnoteAt(20, text), words(260))
  await waitForLayout(page)
  const { placement } = await areas(page)
  expect(placement[0]).toEqual([{ ordinal: 0, start: 0, count: expect.any(Number) }])
  const first = placement[0][0].count
  expect(placement[1][0]).toEqual({ ordinal: 0, start: first, count: expect.any(Number) })
  // Drawn: page 1 shows the following lines, under a full-width continuation rule.
  await expect(page.locator('.nv-frames .nv-page[data-page-index="1"] .nv-fn-note')).toHaveAttribute('data-start', String(first))
  await expect(page.locator('.nv-frames .nv-page[data-page-index="1"] .nv-fn-rule--continued')).toHaveCount(1)
  for (const p of [0, 1]) {
    const o = await overlap(page, p)
    expect(o.hasArea).toBe(true)
    expect(o.bodyBottom, `page ${p}`).toBeLessThanOrEqual(o.areaTop + 0.5)
  }
  // The lines drawn on both pages are consecutive: page 0's area ends where page 1's continues.
  const tops = await page.evaluate(() => {
    const notes = Array.from(document.querySelectorAll<HTMLElement>('.nv-fn-note'))
    return notes.map((n) => ({ start: Number(n.dataset.start), h: n.getBoundingClientRect().height, inner: (n.firstElementChild as HTMLElement).style.marginTop }))
  })
  expect(tops[1].inner).toBe(`-${first * (tops[0].h / first)}px`)
})

test('REGRESSION: a reference on the last line of a page whose note pushes that line on converges', async ({ page }) => {
  await setup(page)
  const before = await layout(page)
  // The last line of page 0 starts after pages[0].to - (a line); put the reference 3 characters
  // before the end of page 0: on its last line (page 0 ends mid-paragraph in this fixture).
  expect(before.pages[1].startsBlockType).toBeNull()
  const at = before.pages[0].to - 3
  await page.evaluate((pos) => window.__nvE2E.insertFootnoteAt(pos, 'A note of a few lines: ' + 'quiet river '.repeat(30)), at)
  await waitForLayout(page)
  const l = await layout(page)
  // Converged and stable: no reflow pending, and the same model a few frames later.
  for (let i = 0; i < 5; i++) await page.evaluate(() => new Promise((r) => requestAnimationFrame(r)))
  expect(await page.evaluate(() => window.__nvE2E.paginationSettled())).toBe(true)
  expect((await layout(page)).layoutVersion).toBe(l.layoutVersion)
  // The note is on the page of its reference, which moved to page 1 with its line.
  const p = await pageOfRef(page, 0)
  expect(p).toBe(1)
  const { placement } = await areas(page)
  expect(placement[p][0]).toMatchObject({ ordinal: 0, start: 0 })
  expect(placement[0] ?? []).toEqual([])
  // Page 0 gave the space back: it ends right before the reference's line (one line less at most).
  expect(l.pages[0].to).toBeLessThan(before.pages[0].to)
  expect(l.pages[0].to).toBeGreaterThan(before.pages[0].to - 200)
  for (const q of [0, 1]) {
    const o = await overlap(page, q)
    expect(o.bodyBottom).toBeLessThanOrEqual(o.areaTop + 0.5)
  }
})

test('footnotes survive save and reopen, and the book.json footnote options too', async ({ page, context }) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  await launch(page)
  await newProject(page, '/projects/Notes')
  await editor(page).click()
  await page.keyboard.type('A sentence with a source')
  await page.keyboard.press('ControlOrMeta+Alt+f')
  await page.keyboard.type('Smith, 1999, p. 4.')
  await page.keyboard.press('Escape')
  await page.keyboard.type(' and more.')
  await page.locator('[data-control-id="footnote.options"]').click()
  await page.locator('[data-control-id="footnote.options.separator"]').uncheck()
  await page.locator('[data-control-id="footnote.options.done"]').click()
  await page.keyboard.press('ControlOrMeta+s')
  await expect(saveStatus(page)).toHaveText('Notes: Saved')
  const saved = JSON.parse((await readFile(page, '/projects/Notes/manuscript.json'))!)
  expect(saved.content[0].content).toEqual([
    { type: 'text', text: 'A sentence with a source' },
    { type: 'footnote', content: [{ type: 'text', text: 'Smith, 1999, p. 4.' }] },
    { type: 'text', text: ' and more.' },
  ])
  const book = JSON.parse((await readFile(page, '/projects/Notes/book.json'))!)
  expect(book.footnotes).toEqual({ separator: false })

  await page.close()
  const again = await context.newPage()
  await again.setViewportSize({ width: 1400, height: 900 })
  await launch(again)
  await openRecent(again, '/projects/Notes')
  await expect(saveStatus(again)).toHaveText('Notes: All changes saved')
  await waitForLayout(again)
  const area = again.locator('.nv-frames .nv-page[data-page-index="0"] .nv-fn-area')
  await expect(area).toHaveText('1 Smith, 1999, p. 4.')
  await expect(area.locator('.nv-fn-rule')).toHaveCount(0)
  await expect(editor(again).locator('[data-footnote-ref]')).toHaveAttribute('data-fn-num', '1')
})

test('a footnote typed before an autosave survives a crash (Restore)', async ({ page, context }) => {
  await page.clock.install()
  await launch(page)
  await newProject(page, '/projects/CrashNotes')
  await editor(page).click()
  await page.keyboard.type('Saved.')
  await page.keyboard.press('ControlOrMeta+s')
  await expect(saveStatus(page)).toHaveText('CrashNotes: Saved')
  await page.keyboard.type(' Claim')
  await page.keyboard.press('ControlOrMeta+Alt+f')
  await page.keyboard.type('Backed-up note.')
  await page.keyboard.press('Escape')
  await page.clock.runFor(31_000)
  await expect(saveStatus(page)).toHaveText(/backed up/)
  await page.close({ runBeforeUnload: false })

  const again = await context.newPage()
  await launch(again)
  await again.locator('[data-control-id="recovery.reopen"]').click()
  await again.locator('[data-control-id="recovery.restore"]').click()
  await expect(editor(again).locator('[data-footnote-ref]')).toHaveAttribute('data-fn-num', '1')
  expect(await again.evaluate(() => window.__nvE2E.footnotes().map((f) => f.text))).toEqual(['Backed-up note.'])
})

test('copy and paste a sentence with a footnote: the note comes along and numbers follow', async ({ page }) => {
  await setup(page, 2)
  await page.evaluate(() => window.__nvE2E.insertFootnoteAt(10, 'Copied note.'))
  await waitForLayout(page)
  // Select the first 20 characters (the reference among them), copy, paste at the end.
  await docStart(page)
  for (let i = 0; i < 20; i++) await page.keyboard.press('Shift+ArrowRight')
  const html = await page.evaluate(() => {
    const data = new DataTransfer()
    document.querySelector('.ProseMirror')!.dispatchEvent(new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true }))
    return data.getData('text/html')
  })
  expect(html).toContain('Copied note.')
  await docEnd(page)
  await page.evaluate((h) => {
    const data = new DataTransfer()
    data.setData('text/html', h)
    document.querySelector('.ProseMirror')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  }, html)
  await waitForLayout(page)
  const notes = await page.evaluate(() => window.__nvE2E.footnotes())
  expect(notes.map((n) => [n.label, n.text])).toEqual([
    ['1', 'Copied note.'],
    ['2', 'Copied note.'],
  ])
})

test('footnote controls: keyboard reachable dialog, tooltips, 32 px reference target', async ({ page }) => {
  await setup(page, 3)
  await page.evaluate(() => window.__nvE2E.insertFootnoteAt(5, 'Note.'))
  await waitForLayout(page)
  const target = await editor(page)
    .locator('[data-footnote-ref]')
    .evaluate((el) => {
      const s = getComputedStyle(el, '::before')
      return { w: parseFloat(s.width), h: parseFloat(s.height) }
    })
  expect(target.w).toBeGreaterThanOrEqual(32)
  expect(target.h).toBeGreaterThanOrEqual(32)
  const btn = page.locator('[data-control-id="footnote.options"]')
  // Keyboard: roving focus from the Insert menu button to Footnotes; keyboard focus shows the tooltip.
  await page.locator('[data-control-id="insert.menu"]').focus()
  await page.keyboard.press('ArrowRight')
  await expect(btn).toBeFocused()
  await expect(page.locator('[data-tooltip-body]')).toContainText('numbered')
  await page.keyboard.press('Enter')
  const dialog = page.getByRole('dialog', { name: 'Footnote options' })
  await expect(dialog).toBeVisible()
  expect(await page.evaluate(() => window.__nvE2E.auditTooltips())).toEqual([])
  await escapeDialog(page, 'Footnote options')
  await expect(btn).toBeFocused()
})
