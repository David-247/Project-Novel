import { expect, test, type Locator, type Page } from '@playwright/test'
import { editor, launch, nativeDialog, newProject, openRecent, pressTab, saveStatus, seedProject, waitForLayout } from './helpers'

/**
 * Track changes review (T7): accept and reject from the change popover, the Review menu, a
 * selection, all changes and all by one author; one undo step each; nothing recorded while tracking;
 * Next / Previous Change across pages in both page views; the popover's keyboard path, tooltips and
 * contrast; the status-bar count.
 */

const ctl = (scope: Page | Locator, id: string) => scope.locator(`[data-control-id="${id}"]`)
const popover = (page: Page) => page.getByTestId('change-popover')
const count = (page: Page) => page.evaluate(() => window.__nvE2E.countChanges())
const blocks = (page: Page) =>
  page.evaluate(() => {
    const doc = window.__nvE2E.docJSON() as { content: { type: string; content?: { text?: string }[] }[] }
    return doc.content.map((b) => (b.content ? b.content.map((c) => c.text ?? '').join('') : `[${b.type}]`))
  })

async function reviewMenu(page: Page, id: string, submenu?: string) {
  const menuBar = page.getByRole('menubar', { name: 'Menu bar' })
  await menuBar.locator('[data-control-id="menu.review"]').click()
  if (submenu) {
    await page.locator(`[role="menu"] [data-control-id="${submenu}"]`).click()
  }
  await page.locator(`[role="menu"] [data-control-id="${id}"]`).click()
}

const DATE = new Date(Date.now() - 2 * 3600_000).toISOString()
const text = (t: string, marks?: unknown[]) => ({ type: 'text', text: t, ...(marks ? { marks } : {}) })
const tc = (type: 'insertion' | 'deletion', id: string, author: string) => ({ type, attrs: { id, author, date: DATE, authorColor: null } })
const stamp = (id: string, author = 'Ann') => ({ id, author, date: DATE })

async function seedReview(page: Page, folder: string, content: unknown[]) {
  const title = folder.split('/').pop()!
  await seedProject(page, folder, title, { type: 'doc', content })
  await openRecent(page, folder)
  await expect(saveStatus(page)).toHaveText(`${title}: All changes saved`)
  await waitForLayout(page)
}

test('a tester edits with tracking on, then accepts and rejects from the popover, the menu and a selection', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  await launch(page)
  await newProject(page, '/projects/Review')
  await editor(page).click()
  await page.keyboard.type('The cat sat on the mat.')
  await page.keyboard.press('ControlOrMeta+Shift+E')
  // Delete "mat." and type "rug."; Enter splits; a new paragraph is typed.
  for (let i = 0; i < 4; i++) await page.keyboard.press('Backspace')
  await page.keyboard.type('rug.')
  await page.keyboard.press('Enter')
  await page.keyboard.type('New line.')
  await expect(page.getByTestId('changes-indicator')).toHaveText(/\d+ changes?/)
  const before = await count(page)
  expect(before).toBeGreaterThanOrEqual(1)

  // Click on the inserted "rug." opens the popover (author, date, kind, preview).
  await editor(page).locator('.nv-ins', { hasText: 'rug.' }).first().click()
  await expect(popover(page)).toBeVisible()
  // Deleting "mat." and typing "rug." is one change (a replacement).
  await expect(page.getByTestId('change-popover-kind')).toContainText(/Replaced|Inserted/)
  await expect(popover(page)).toContainText(/ago|just now/)
  // Accept from the popover: the mark goes, the text stays; nothing new is recorded with tracking on.
  await ctl(popover(page), 'review.popover.accept').click()
  await expect(popover(page)).toHaveCount(0)
  expect(await count(page)).toBe(before - 1)
  expect((await blocks(page))[0]).toBe('The cat sat on the rug.')
  // One undo step brings the change back.
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(() => count(page)).toBe(before)

  // Reject from the menu at the caret: inside the deleted "mat.".
  // (The caret sat before the deleted text, so Enter carried it into the new paragraph.)
  await editor(page).locator('.nv-del').first().click()
  await reviewMenu(page, 'review.reject')
  await expect.poll(() => count(page)).toBe(before - 1)
  await expect(editor(page).locator('.nv-del')).toHaveCount(0)
  expect((await blocks(page)).join('|')).toBe('The cat sat on the rug.|New line.mat.')
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(() => count(page)).toBe(before)

  // A selection over everything: Accept Change accepts every change in it.
  await editor(page).click()
  await page.keyboard.press('ControlOrMeta+a')
  await reviewMenu(page, 'review.accept')
  await expect.poll(() => count(page)).toBe(0)
  expect(await blocks(page)).toEqual(['The cat sat on the rug.', 'New line.'])
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(() => count(page)).toBe(before)
  // Tracking stayed on and recorded nothing for any of it.
  await expect(ctl(page, 'review.track')).toHaveAttribute('aria-pressed', 'true')
})

test('Accept All, Reject All (confirmed above 50 changes) and Accept All by one author', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  await launch(page)
  const content = [
    { type: 'paragraph', content: [text('Kept '), text('old ', [tc('deletion', 'd1', 'Ann')]), text('new ', [tc('insertion', 'i1', 'Bob')]), text('end.')] },
    { type: 'paragraph', attrs: { trackedInsert: stamp('s1', 'Ann') }, content: [text('Split half.')] },
    { type: 'pageBreak', attrs: { trackedInsert: stamp('pb', 'Bob') } },
    { type: 'paragraph', content: [text('Note'), { type: 'footnote', marks: [tc('deletion', 'fn', 'Ann')], content: [text('A deleted note')] }, text(' here.')] },
    ...Array.from({ length: 50 }, (_, i) => ({ type: 'paragraph', content: [text(`Line ${i} `), text('added', [tc('insertion', `m${i}`, 'Cy')])] })),
  ]
  await seedReview(page, '/projects/All', content)
  expect(await count(page)).toBe(55)

  // By author: Bob's two changes only.
  await reviewMenu(page, 'review.acceptAll.author.1', 'menu.review.accept-all-by-author')
  await expect.poll(() => count(page)).toBe(53)
  expect((await blocks(page)).slice(0, 4)).toEqual(['Kept old new end.', 'Split half.', '[pageBreak]', 'Note here.'])

  // Reject All of 53 changes: asks first. Cancel leaves them.
  await reviewMenu(page, 'review.rejectAll')
  await expect(nativeDialog(page)).toContainText('53 changes')
  await nativeDialog(page).getByRole('button', { name: 'Cancel' }).click()
  expect(await count(page)).toBe(53)
  await reviewMenu(page, 'review.rejectAll')
  await nativeDialog(page).getByRole('button', { name: 'Reject All' }).click()
  await expect.poll(() => count(page)).toBe(0)
  // Insertions gone, deletions (the note) back, the split joined.
  const rejected = await blocks(page)
  expect(rejected.slice(0, 3)).toEqual(['Kept old new end.Split half.', '[pageBreak]', 'Note here.'])
  expect(await page.evaluate(() => window.__nvE2E.footnotes().map((f) => f.text))).toEqual(['A deleted note'])
  expect(rejected[3]).toBe('Line 0 ')

  // Undo (one step), then Accept All: the deleted note and text go, the split stays.
  await editor(page).click()
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(() => count(page)).toBe(53)
  await reviewMenu(page, 'review.acceptAll')
  await nativeDialog(page).getByRole('button', { name: 'Accept All' }).click()
  await expect.poll(() => count(page)).toBe(0)
  const accepted = await blocks(page)
  expect(accepted.slice(0, 4)).toEqual(['Kept new end.', 'Split half.', '[pageBreak]', 'Note here.'])
  expect(accepted[4]).toBe('Line 0 added')
  expect(await page.evaluate(() => window.__nvE2E.footnotes().length)).toBe(0)
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(() => count(page)).toBe(53)
})

test('Next and Previous Change go across pages in spread and single-page view; the status count goes next', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  await launch(page)
  const para = (n: number) => Array.from({ length: 90 }, (_, i) => `w${n}x${i}`).join(' ')
  const content = Array.from({ length: 30 }, (_, i) =>
    i === 0 || i === 14 || i === 29
      ? { type: 'paragraph', content: [text(`Chg${i}`, [tc('insertion', `c${i}`, 'Ann')]), text(` ${para(i)}`)] }
      : { type: 'paragraph', content: [text(para(i))] },
  )
  await seedReview(page, '/projects/Walk', content)
  const where = () =>
    page.evaluate(() => {
      const l = window.__nvE2E.layout()
      const sel = window.__nvE2E.selection()!
      const p = l.pages.findIndex((pg, i) => sel.from >= pg.from && (sel.from < pg.to || i === l.pages.length - 1))
      return { from: sel.from, to: sel.to, page: p, first: l.visibleSpread.first, last: l.visibleSpread.last }
    })

  for (const view of ['spread', 'single'] as const) {
    await page.evaluate((v) => window.__nvE2E.setBookView(v), view)
    await waitForLayout(page)
    await page.evaluate(() => window.__nvE2E.selectText(1, 1))
    const pagesSeen: number[] = []
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press('ControlOrMeta+Alt+ArrowDown')
      await waitForLayout(page)
      await expect.poll(async () => { const w = await where(); return w.page >= w.first && w.page <= w.last }, { message: `${view} step ${i}` }).toBe(true)
      pagesSeen.push((await where()).page)
    }
    // c14 and c29 sit on later pages; the walk wraps back to c0 on page 0.
    expect(pagesSeen[0]).toBeGreaterThan(0)
    expect(pagesSeen[1]).toBeGreaterThan(pagesSeen[0])
    expect(pagesSeen[2]).toBe(0)
    await page.keyboard.press('ControlOrMeta+Alt+ArrowUp')
    await waitForLayout(page)
    expect((await where()).page).toBe(pagesSeen[1])
  }

  // The status-bar count is a button: it goes to the next change.
  const indicator = page.getByTestId('changes-indicator')
  await expect(indicator).toHaveText('3 changes')
  await page.evaluate(() => window.__nvE2E.selectText(1, 1))
  await indicator.click()
  await waitForLayout(page)
  const w = await where()
  expect(w.page).toBeGreaterThan(0)
  expect(w.page).toBeGreaterThanOrEqual(w.first)
  expect(w.page).toBeLessThanOrEqual(w.last)
})

test('the popover from the keyboard: Alt+Enter, Tab, Escape; tooltips and AA contrast on all papers', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  await launch(page)
  await seedReview(page, '/projects/Keys', [
    { type: 'paragraph', content: [text('Start '), text('inserted words', [tc('insertion', 'k1', 'Ann')]), text(' then '), text('removed', [tc('deletion', 'k2', 'Bob')]), text(' end.')] },
  ])
  await editor(page).click()
  await page.evaluate(() => window.__nvE2E.selectText(9, 9))
  await page.keyboard.press('Alt+Enter')
  await expect(popover(page)).toBeVisible()
  await expect(ctl(popover(page), 'review.popover.accept')).toBeFocused()
  await expect(page.getByTestId('change-popover-author')).toHaveText('Ann')
  await pressTab(page)
  await expect(ctl(popover(page), 'review.popover.reject')).toBeFocused()
  await pressTab(page)
  await expect(ctl(popover(page), 'review.popover.accept')).toBeFocused()
  // Tooltip on keyboard focus; every control registered.
  await pressTab(page, { shift: true })
  await expect(page.getByRole('tooltip').filter({ hasText: 'Undo this change' })).toBeVisible()
  expect(await page.evaluate(() => window.__nvE2E.auditTooltips())).toEqual([])
  // Escape returns to the text, the change untouched.
  await page.keyboard.press('Escape')
  await expect(popover(page)).toHaveCount(0)
  await expect(editor(page)).toBeFocused()
  expect(await count(page)).toBe(2)
  // No popover in No Markup.
  await page.evaluate(() => window.__nvE2E.setMarkupView('none'))
  await page.evaluate(() => window.__nvE2E.selectText(9, 9))
  await page.keyboard.press('Alt+Enter')
  await expect(popover(page)).toHaveCount(0)
  await page.evaluate(() => window.__nvE2E.setMarkupView('all'))
  // A drag across a change selects text without opening the popover.
  const ins = editor(page).locator('.nv-ins').first()
  const box = (await ins.boundingBox())!
  await page.mouse.move(box.x + 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2, { steps: 8 })
  await page.mouse.up()
  await expect(popover(page)).toHaveCount(0)
  // Enter on the focused Accept accepts.
  await page.evaluate(() => window.__nvE2E.selectText(9, 9))
  await page.keyboard.press('Alt+Enter')
  await page.keyboard.press('Enter')
  await expect(popover(page)).toHaveCount(0)
  expect(await count(page)).toBe(1)
  await page.keyboard.press('ControlOrMeta+z')
  expect(await count(page)).toBe(2)

  // Contrast of the popover text and buttons, four papers x light / dark.
  const failures: string[] = []
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    await expect(page.locator('html')).toHaveAttribute('data-theme', scheme)
    for (const surface of ['auto', 'book', 'white', 'dark'] as const) {
      await ctl(page, `book.surface.${surface}`).click()
      await editor(page).click()
      await page.evaluate(() => window.__nvE2E.selectText(9, 9))
      await page.keyboard.press('Alt+Enter')
      await expect(popover(page)).toBeVisible()
      await page.evaluate(() => new Promise((r) => setTimeout(r, 300)))
      const r = await page.evaluate(() => {
        const parse = (c: string) => (c.match(/rgba?\(([^)]+)\)/)?.[1].split(/[ ,/]+/).filter(Boolean).map(Number) ?? [0, 0, 0, 0]) as number[]
        const over = (top: number[], under: number[]) => [0, 1, 2].map((i) => top[i] * (top[3] ?? 1) + under[i] * (1 - (top[3] ?? 1)))
        const bgOf = (el: Element) => {
          const layers: number[][] = []
          for (let n: Element | null = el; n; n = n.parentElement) {
            const c = parse(getComputedStyle(n).backgroundColor)
            if ((c[3] ?? 1) > 0) {
              layers.push(c)
              if ((c[3] ?? 1) >= 1) break
            }
          }
          let out = [255, 255, 255]
          for (const l of layers.reverse()) out = over(l, out)
          return out
        }
        const lum = (rgb: number[]) =>
          rgb.map((v) => v / 255).map((s) => (s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4)).reduce((a, c, i) => a + c * [0.2126, 0.7152, 0.0722][i], 0)
        const ratio = (a: number[], b: number[]) => {
          const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p)
          return (x + 0.05) / (y + 0.05)
        }
        const sample = (el: Element) => ratio(over(parse(getComputedStyle(el).color), bgOf(el)), bgOf(el))
        const pop = document.querySelector('[data-testid="change-popover"]')!
        const out: Record<string, number> = {}
        for (const [name, sel] of Object.entries({
          author: '[data-testid="change-popover-author"]',
          time: 'time',
          preview: '[data-testid="change-popover-preview"]',
          accept: '[data-control-id="review.popover.accept"]',
          reject: '[data-control-id="review.popover.reject"]',
        })) {
          const el = pop.querySelector(sel)
          if (el) out[name] = +sample(el).toFixed(2)
        }
        const ind = document.querySelector('[data-testid="changes-indicator"]')
        if (ind) out.indicator = +sample(ind).toFixed(2)
        return out
      })
      for (const [k, v] of Object.entries(r)) if (v < 4.5) failures.push(`${scheme}/${surface} ${k} ${v}`)
      await page.keyboard.press('Escape')
    }
  }
  expect(failures).toEqual([])
})
