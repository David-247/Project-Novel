import { expect, test, type Locator, type Page } from '@playwright/test'
import { editor, launch, newProject, openRecent, pressTab, recoveryControl, saveStatus, seedProject, waitForLayout, writeFile } from './helpers'

/**
 * Comments (Phase 3): anchored threads in the margin panel. Full flow with undo / redo of every step,
 * persistence across reopen and crash recovery, card alignment and stacking, the drawer in a narrow
 * window, Next / Previous Comment in both page views, tooltips, keyboard access and contrast.
 */

const ctl = (scope: Page | Locator, id: string) => scope.locator(`[data-control-id="${id}"]`)
const cards = (page: Page) => page.locator('[data-testid="comments-panel"] article[data-thread-id]:not([data-thread-id="draft"])')
const texts = (card: Locator) => card.locator('[data-testid="comment-text"]')
const anchors = (page: Page) => editor(page).locator('.nv-comment')
const undo = (page: Page) => ctl(page, 'history.undo').click()
const redo = (page: Page) => ctl(page, 'history.redo').click()
const comments = (page: Page) => page.evaluate(() => window.__nvE2E.comments())

const SENTENCE = 'The quick brown fox jumps over the lazy dog.'

async function freshProject(page: Page, name: string) {
  await launch(page)
  await newProject(page, `/projects/${name}`)
  await editor(page).click()
  await page.keyboard.type(SENTENCE)
}

/** Select `from..to` and add a comment through the toolbar button and the composer. */
async function addComment(page: Page, from: number, to: number, body: string) {
  await page.evaluate(([f, t]) => window.__nvE2E.selectText(f, t), [from, to] as const)
  await ctl(page, 'comment.new').click()
  const field = ctl(page, 'comment.composeField')
  await expect(field).toBeFocused()
  await field.fill(body)
  await page.keyboard.press('ControlOrMeta+Enter')
  await expect(field).toHaveCount(0)
}

const text = (t: string, marks?: unknown[]) => ({ type: 'text', text: t, ...(marks ? { marks } : {}) })
const mark = (id: string) => ({ type: 'comment', attrs: { id } })
const thread = (id: string, body: string, extra: Record<string, unknown> = {}) => ({
  id,
  createdAt: '2026-11-01T10:00:00.000Z',
  author: 'Author',
  resolved: false,
  messages: [{ id: `${id}-m`, author: 'Author', date: '2026-11-01T10:00:00.000Z', text: body }],
  ...extra,
})

/** A project whose manuscript carries comment marks, with its comments.json. */
async function seedCommented(page: Page, folder: string, content: unknown[], threads: unknown[]) {
  const title = folder.split('/').pop()!
  await seedProject(page, folder, title, { type: 'doc', content })
  await writeFile(page, `${folder}/comments.json`, JSON.stringify({ version: 1, threads }, null, 2))
  await openRecent(page, folder)
  await expect(saveStatus(page)).toHaveText(`${title}: All changes saved`)
  await waitForLayout(page)
}

test('add, reply, edit, resolve, reopen and delete a comment; every step undoes and redoes', async ({ page }) => {
  await freshProject(page, 'Flow')
  await addComment(page, 5, 10, 'Is "quick" the word?')
  const card = cards(page)
  await expect(card).toHaveCount(1)
  await expect(texts(card)).toHaveText(['Is "quick" the word?'])
  await expect(anchors(page)).toHaveText('quick')

  await undo(page)
  await expect(card).toHaveCount(0)
  await expect(anchors(page)).toHaveCount(0)
  await redo(page)
  await expect(texts(card)).toHaveText(['Is "quick" the word?'])
  await expect(anchors(page)).toHaveText('quick')

  // Reply
  await ctl(card, 'comment.replyStart').click()
  await ctl(card, 'comment.replyField').fill('Maybe "swift".\nOr "fast".')
  await ctl(card, 'comment.reply').click()
  await expect(texts(card)).toHaveText(['Is "quick" the word?', 'Maybe "swift".\nOr "fast".'])
  await undo(page)
  await expect(texts(card)).toHaveCount(1)
  await redo(page)
  await expect(texts(card)).toHaveCount(2)

  // Edit the reply
  await ctl(card.locator('li').nth(1), 'comment.edit').click()
  await ctl(card, 'comment.editField').fill('Swift it is.')
  await ctl(card, 'comment.editSave').click()
  await expect(texts(card).nth(1)).toHaveText('Swift it is.')
  await expect(card).toContainText('edited')
  await undo(page)
  await expect(texts(card).nth(1)).toHaveText('Maybe "swift".\nOr "fast".')
  await redo(page)
  await expect(texts(card).nth(1)).toHaveText('Swift it is.')

  // Resolve: hidden (and unhighlighted) until Show Resolved
  await ctl(card, 'comment.resolve').click()
  await expect(card).toHaveCount(0)
  await expect(anchors(page).first()).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await undo(page)
  await expect(card).toHaveCount(1)
  await redo(page)
  await expect(card).toHaveCount(0)
  // The panel stays while every comment is resolved: Show Resolved brings the card back.
  await ctl(page, 'comment.showResolved').click()
  await expect(card).toHaveCount(1)
  await expect(card).toContainText('Resolved by Test Writer')

  // Reopen
  await ctl(card, 'comment.reopen').click()
  await expect(ctl(card, 'comment.resolve')).toBeVisible()
  await undo(page)
  await expect(ctl(card, 'comment.reopen')).toBeVisible()
  await redo(page)
  await expect(ctl(card, 'comment.resolve')).toBeVisible()

  // Delete the thread: card and highlight go; undo brings both back with the replies
  await ctl(card, 'comment.delete').click()
  await expect(card).toHaveCount(0)
  await expect(anchors(page)).toHaveCount(0)
  await undo(page)
  await expect(texts(card)).toHaveText(['Is "quick" the word?', 'Swift it is.'])
  await expect(anchors(page)).toHaveText('quick')
  await redo(page)
  await expect(card).toHaveCount(0)
})

test('deleting the anchored text hides the thread; undo restores it', async ({ page }) => {
  await freshProject(page, 'Anchor')
  await addComment(page, 11, 16, 'Colour?')
  await expect(cards(page)).toHaveCount(1)
  await page.evaluate(() => window.__nvE2E.selectText(10, 17))
  await editor(page).press('Backspace')
  await expect(cards(page)).toHaveCount(0)
  expect((await comments(page)).threads).toHaveLength(1) // hidden, not destroyed
  await editor(page).press('ControlOrMeta+z')
  await expect(cards(page)).toHaveCount(1)
  await expect(anchors(page)).toHaveText('brown')
})

test('comments survive save and reopen, and crash recovery', async ({ page, context }) => {
  await page.clock.install()
  await freshProject(page, 'Kept')
  await addComment(page, 5, 10, 'Saved comment')
  await editor(page).press('ControlOrMeta+s')
  await expect(saveStatus(page)).toHaveText('Kept: Saved')
  const saved = JSON.parse((await page.evaluate(() => window.__nvE2E.readFile('/projects/Kept/comments.json')))!)
  expect(saved).toMatchObject({ version: 1, threads: [{ author: 'Test Writer', resolved: false, messages: [{ text: 'Saved comment' }] }] })
  const manuscript = (await page.evaluate(() => window.__nvE2E.readFile('/projects/Kept/manuscript.json')))!
  expect(manuscript).toContain(`"type":"comment","attrs":{"id":"${saved.threads[0].id}"}`)

  // An unsaved reply, backed up by autosave, then a crash.
  const card = cards(page)
  await ctl(card, 'comment.replyStart').click()
  await ctl(card, 'comment.replyField').fill('Unsaved reply')
  await ctl(card, 'comment.reply').click()
  await expect(texts(card)).toHaveCount(2)
  await page.clock.runFor(31_000)
  await expect(saveStatus(page)).toHaveText(/^Kept: Unsaved changes · backed up \d/)
  await page.close({ runBeforeUnload: false })

  const relaunched = await context.newPage()
  await launch(relaunched)
  await recoveryControl(relaunched, 'reopen').click()
  // Opened as saved: the comment without the reply.
  await expect(relaunched.getByRole('dialog', { name: 'Restore unsaved changes?' })).toBeVisible()
  await recoveryControl(relaunched, 'restore').click()
  const again = cards(relaunched)
  await expect(texts(again)).toHaveText(['Saved comment', 'Unsaved reply'])
  await expect(anchors(relaunched)).toHaveText('quick')
  await editor(relaunched).press('ControlOrMeta+s')
  await expect(saveStatus(relaunched)).toHaveText('Kept: Saved')

  // A plain reopen (no crash) shows the saved thread.
  await relaunched.close({ runBeforeUnload: false })
  const third = await context.newPage()
  await launch(third)
  await openRecent(third, '/projects/Kept')
  await expect(saveStatus(third)).toHaveText('Kept: All changes saved')
  await expect(texts(cards(third))).toHaveText(['Saved comment', 'Unsaved reply'])
})

test('a project without comments.json opens unchanged and saves no comments.json', async ({ page }) => {
  await launch(page)
  await seedProject(page, '/projects/Old', 'Old', { type: 'doc', content: [{ type: 'paragraph', content: [text('Phase 2 text.')] }] })
  await openRecent(page, '/projects/Old')
  await expect(saveStatus(page)).toHaveText('Old: All changes saved')
  await editor(page).click()
  await page.keyboard.type(' More.')
  await editor(page).press('ControlOrMeta+s')
  await expect(saveStatus(page)).toHaveText('Old: Saved')
  expect(await page.evaluate(() => window.__nvE2E.readFile('/projects/Old/comments.json'))).toBeNull()
  await expect(page.locator('[data-testid="comments-panel"]')).toHaveCount(0)
})

test('cards align with their anchor lines and stack without overlap; the active card is pulled to its anchor', async ({ page }) => {
  await launch(page)
  const words = (n: number, k: string) => Array.from({ length: n }, (_, i) => `${k}${i}`).join(' ')
  await seedCommented(
    page,
    '/projects/Stack',
    [
      // Three anchors on one line half-way down the first page, a fourth further down.
      { type: 'paragraph', content: [text(words(210, 'w') + ' '), text('Alpha', [mark('a')]), text(' beta '), text('gamma', [mark('b')]), text(' delta '), text('epsilon', [mark('c')]), text(` ${words(10, 'v')}`)] },
      { type: 'paragraph', content: [text(words(20, 'u') + ' '), text('far', [mark('d')]), text(' away.')] },
    ],
    [thread('a', 'First'), thread('b', 'Second, with a longer note that wraps onto more lines in the card.'), thread('c', 'Third'), thread('d', 'Fourth')],
  )
  await expect(cards(page)).toHaveCount(4)
  const measure = () =>
    page.evaluate(() => {
      const box = document.querySelector('[data-testid="comment-cards"]')!.getBoundingClientRect()
      return Array.from(document.querySelectorAll<HTMLElement>('.nv-comment-slot')).map((slot) => {
        const id = slot.dataset.slot!
        const anchor = document.querySelector(`.novel-editor-content [data-comment-id="${id}"]`)!.getClientRects()[0]
        return { id, top: box.top + Number(slot.dataset.top), height: slot.offsetHeight, anchorTop: anchor.top }
      })
    })
  let m = await measure()
  expect(m.map((c) => c.id)).toEqual(['a', 'b', 'c', 'd'])
  // The first card is level with its anchor's line; the next ones stack downward without overlap.
  expect(Math.abs(m[0].top - m[0].anchorTop)).toBeLessThanOrEqual(2)
  for (let i = 1; i < m.length; i++) {
    expect(m[i].top).toBeGreaterThanOrEqual(m[i - 1].top + m[i - 1].height)
    expect(m[i].top).toBeGreaterThanOrEqual(m[i].anchorTop - 2)
  }
  // A card with room above it is level with its anchor.
  for (let i = 1; i < m.length; i++) {
    if (m[i - 1].top + m[i - 1].height + 8 <= m[i].anchorTop) expect(Math.abs(m[i].top - m[i].anchorTop)).toBeLessThanOrEqual(2)
  }

  // Selecting the third thread (caret in its anchor) pulls its card to the anchor; the others stack upward.
  await page.locator('.novel-editor-content [data-comment-id="c"]').click()
  await expect.poll(async () => (await comments(page)).activeId).toBe('c')
  await expect(cards(page).nth(2)).toHaveAttribute('data-active', 'true')
  await expect.poll(async () => {
    m = await measure()
    return Math.abs(m[2].top - m[2].anchorTop)
  }, { message: JSON.stringify(m) }).toBeLessThanOrEqual(2)
  for (let i = 1; i < m.length; i++) expect(m[i].top).toBeGreaterThanOrEqual(m[i - 1].top + m[i - 1].height)
  // Connector: the selected thread's anchor is highlighted more strongly (not by hover alone).
  const lit = await page.locator('.novel-editor-content [data-comment-id="c"]').evaluate((el) => getComputedStyle(el).boxShadow)
  expect(lit).not.toBe('none')

  // Zoom changes move the cards with the text.
  await ctl(page, 'pagination.zoomIn').click()
  await waitForLayout(page)
  await expect.poll(async () => {
    m = await measure()
    return Math.abs(m[2].top - m[2].anchorTop)
  }, { message: JSON.stringify(m) }).toBeLessThanOrEqual(2)
})

test('a narrow window shows the comments in a drawer; tapping a thread jumps to its anchor', async ({ page }) => {
  await page.setViewportSize({ width: 820, height: 800 })
  await launch(page)
  await seedCommented(
    page,
    '/projects/Narrow',
    [{ type: 'paragraph', content: [text('Some '), text('marked', [mark('n1')]), text(' text and '), text('more', [mark('n2')]), text('.')] }],
    [thread('n1', 'One'), thread('n2', 'Two')],
  )
  await expect(page.locator('[data-comments-layout="drawer"]')).toHaveCount(1)
  await expect(page.locator('[data-testid="comments-panel"]')).toHaveCount(0)
  await ctl(page, 'comment.panel').click()
  const drawer = page.getByRole('dialog', { name: 'Comments' })
  await expect(drawer).toBeVisible()
  await expect(drawer.locator('article')).toHaveCount(2)
  await expect(texts(drawer.locator('article'))).toHaveText(['One', 'Two']) // document order
  await ctl(drawer.locator('article').nth(1), 'comment.jump').click()
  expect(await page.evaluate(() => window.__nvE2E.selection())).toEqual({ from: 22, to: 26 })
  expect((await comments(page)).activeId).toBe('n2')
  await ctl(drawer, 'comment.next').focus()
  await page.keyboard.press('Escape')
  await expect(drawer).toHaveCount(0)

  // Touch widths: a bottom sheet.
  await page.setViewportSize({ width: 420, height: 800 })
  await ctl(page, 'comment.panel').click()
  await expect(page.locator('[data-testid="comments-drawer"][data-sheet]')).toBeVisible()
  // Wide again: the margin panel.
  await page.setViewportSize({ width: 1400, height: 800 })
  await expect(page.locator('[data-testid="comments-panel"]')).toBeVisible()
})

test('Next and Previous Comment walk the comments in spread and single-page view', async ({ page }) => {
  await launch(page)
  const para = (n: number) => Array.from({ length: 90 }, (_, i) => `w${n}x${i}`).join(' ')
  const content = Array.from({ length: 30 }, (_, i) =>
    i === 0 || i === 14 || i === 29
      ? { type: 'paragraph', content: [text('Mark', [mark(`p${i}`)]), text(` ${para(i)}`)] }
      : { type: 'paragraph', content: [text(para(i))] },
  )
  await seedCommented(page, '/projects/Walk', content, [thread('p0', 'Start'), thread('p14', 'Middle'), thread('p29', 'End')])
  const pageOfSelection = () =>
    page.evaluate(() => {
      const { pages } = window.__nvE2E.layout()
      const sel = window.__nvE2E.selection()!
      return pages.findIndex((p, i) => sel.from >= p.from && (sel.from < p.to || i === pages.length - 1))
    })

  for (const view of ['spread', 'single'] as const) {
    await page.evaluate((v) => window.__nvE2E.setBookView(v), view)
    await waitForLayout(page)
    await page.evaluate(() => window.__nvE2E.selectText(1, 1))
    const seen: string[] = []
    for (let i = 0; i < 4; i++) {
      await ctl(page, 'comment.next').click()
      const c = await comments(page)
      seen.push(c.activeId!)
      await waitForLayout(page)
      // The panel shows the visible spread's comments: the active one is among them.
      await expect(page.locator(`[data-testid="comments-panel"] article[data-thread-id="${c.activeId}"]`)).toBeVisible()
      const spread = (await page.evaluate(() => window.__nvE2E.layout())).visibleSpread
      const p = await pageOfSelection()
      expect(p, `${view}: page of ${c.activeId}`).toBeGreaterThanOrEqual(spread.first)
      expect(p).toBeLessThanOrEqual(spread.last)
    }
    expect(seen, view).toEqual(['p14', 'p29', 'p0', 'p14'])
    await ctl(page, 'comment.prev').click()
    expect((await comments(page)).activeId, view).toBe('p0')
  }
})

test('comment controls have tooltips, work from the keyboard, and pass AA contrast on all papers', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  await freshProject(page, 'Access')
  // Keyboard: select a word, Mod-Alt-m opens the composer with the focus in it, Mod-Enter adds it.
  await page.evaluate(() => window.__nvE2E.selectText(1, 4))
  await page.keyboard.press('ControlOrMeta+Alt+m')
  await expect(ctl(page, 'comment.composeField')).toBeFocused()
  await page.keyboard.type('Keyboard comment')
  await page.keyboard.press('ControlOrMeta+Enter')
  const card = cards(page)
  await expect(card).toHaveCount(1)
  await expect(editor(page)).toBeFocused()
  // Escape in a fresh composer cancels it.
  await page.evaluate(() => window.__nvE2E.selectText(11, 16))
  await page.keyboard.press('ControlOrMeta+Alt+m')
  await expect(ctl(page, 'comment.composeField')).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(ctl(page, 'comment.composeField')).toHaveCount(0)

  // The card and its buttons are reachable with Tab; Enter activates.
  await card.focus()
  await pressTab(page)
  const focusedId = await page.evaluate(() => document.activeElement?.getAttribute('data-control-id'))
  expect(focusedId).toMatch(/^comment\./)
  await ctl(card, 'comment.replyStart').focus()
  await page.keyboard.press('Enter')
  await expect(ctl(card, 'comment.replyField')).toBeFocused()

  // Every control (panel header, card, reply field) has a registered, wired tooltip.
  expect(await page.evaluate(() => window.__nvE2E.auditTooltips())).toEqual([])
  // Tooltip on keyboard focus.
  await ctl(page, 'comment.next').focus()
  await pressTab(page, { shift: true })
  await pressTab(page)
  await expect(page.getByRole('tooltip').filter({ hasText: 'Next Comment' })).toBeVisible()

  // Contrast of the highlighted anchor text and the card text, four papers x light / dark.
  const failures: string[] = []
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    await expect(page.locator('html')).toHaveAttribute('data-theme', scheme)
    for (const surface of ['auto', 'book', 'white', 'dark'] as const) {
      await ctl(page, `book.surface.${surface}`).click()
      await page.evaluate(() => new Promise((r) => setTimeout(r, 300)))
      for (const active of [false, true]) {
        await page.evaluate((a) => (a ? window.__nvE2E.selectText(2, 2) : window.__nvE2E.selectText(20, 20)), active)
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
          const anchor = document.querySelector('.novel-editor-content .nv-comment')!
          const cardText = document.querySelector('[data-testid="comments-panel"] [data-testid="comment-text"]')!
          return { anchor: +sample(anchor).toFixed(2), card: +sample(cardText).toFixed(2) }
        })
        if (r.anchor < 4.5) failures.push(`${scheme}/${surface}${active ? ' active' : ''} anchor ${r.anchor}`)
        if (r.card < 4.5) failures.push(`${scheme}/${surface} card ${r.card}`)
      }
    }
  }
  expect(failures).toEqual([])
})

test('Review > New Comment asks for the author name first when none is known; View > Comments Panel toggles', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  await page.addInitScript(() => {
    window.__nvE2EConfig = { ...(window.__nvE2EConfig ?? {}), defaultAuthor: '' }
  })
  await freshProject(page, 'Menus')
  await page.evaluate(() => window.__nvE2E.selectText(5, 10))
  const menuBar = page.getByRole('menubar', { name: 'Menu bar' })
  await menuBar.locator('[data-control-id="menu.review"]').click()
  await page.locator('[role="menu"] [data-control-id="comment.new"]').click()
  // The one-time question comes before the composer.
  const prompt = page.getByRole('dialog', { name: 'Who is writing?' })
  await expect(prompt).toBeVisible()
  await expect(ctl(page, 'comment.composeField')).toHaveCount(0)
  await ctl(page, 'settings.prompt.name').fill('Menu Writer')
  await ctl(page, 'settings.prompt.save').click()
  await expect(prompt).toBeHidden()
  const field = ctl(page, 'comment.composeField')
  await expect(field).toBeFocused()
  await field.fill('From the menu')
  await page.keyboard.press('ControlOrMeta+Enter')
  await expect(cards(page)).toHaveCount(1)
  await expect(cards(page).first()).toContainText('Menu Writer')

  // View > Comments Panel is a check item mirroring the panel.
  const panelItem = page.locator('[role="menu"] [data-control-id="comment.panel"]')
  await menuBar.locator('[data-control-id="menu.view"]').click()
  await expect(panelItem).toHaveAttribute('aria-checked', 'true')
  await panelItem.click()
  await expect(cards(page)).toHaveCount(0)
  await menuBar.locator('[data-control-id="menu.view"]').click()
  await expect(panelItem).toHaveAttribute('aria-checked', 'false')
  await page.keyboard.press('Escape')
})
