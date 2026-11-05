import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test'
import { buildPaginationFixture } from './fixtures/pagination-manuscript'
import {
  clickBlockStart,
  docEnd,
  docStart,
  editor,
  isBookMode,
  launch,
  nativeDialog,
  openRecent,
  projectNavigation,
  readFile,
  recoveryControl,
  reveal,
  saveStatus,
  seedProject,
  seedProjectNavigation,
  showPage,
  turnSettled,
  waitForLayout,
} from './helpers'

/**
 * Phase 3 acceptance (Revision Tools), end to end through the UI on the ~100k-word fixture, in
 * chromium and webkit, in Book mode (page turns, the default):
 *  1. track changes: turn recording on, edit a chapter, accept and reject one change, then Accept All
 *     and Reject All (each undone);
 *  2. comments: add one, reply, resolve;
 *  3. re-write: open it on a paragraph, toggle two versions, keep one, undo the choice (the original
 *     comes back and the re-write is open again with both versions), redo;
 *  4. after every step: save, reopen, and an unsaved follow-up edit restored after a crash;
 *  5. page-turn navigation and caret follow throughout (the caret's page is on the spread shown).
 * The navigation and caret-follow checks also run in continuous scroll (the *-scroll projects).
 */

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(projectNavigation(testInfo) === 'scroll' && !testInfo.title.startsWith('navigation'), 'Book mode scenario (navigation runs in both)')
  await seedProjectNavigation(page, testInfo)
})

const FOLDER = '/projects/Phase3'
const TITLE = 'Phase3'

const ctl = (scope: Page | Locator, id: string) => scope.locator(`[data-control-id="${id}"]`)
const layout = (page: Page) => page.evaluate(() => window.__nvE2E.layout())
const count = (page: Page) => page.evaluate(() => window.__nvE2E.countChanges())
const popover = (page: Page) => page.getByTestId('change-popover')
const cards = (page: Page) => page.locator('[data-testid="comments-panel"] article[data-thread-id]:not([data-thread-id="draft"])')
const comments = (page: Page) => page.evaluate(() => window.__nvE2E.comments())
const rw = (page: Page) => page.evaluate(() => window.__nvE2E.rewrite())
const rwView = (page: Page) => page.getByTestId('rewrite-view')
const revision = (page: Page) => page.getByRole('textbox', { name: 'Revised passage' })
const indicator = (page: Page) => page.getByTestId('page-indicator')
const blockEl = (page: Page, i: number) => editor(page).locator(':scope > :is(p, h1)').nth(i)

type Json = { type: string; text?: string; attrs?: Record<string, unknown>; content?: Json[]; marks?: { type: string }[] }

/** The fixture, and the indices of a chapter's heading and its paragraphs. */
function fixture() {
  const fx = buildPaginationFixture()
  const content = fx.doc.content as Json[]
  const headings = content.map((n, i) => (n.type === 'heading' ? i : -1)).filter((i) => i >= 0)
  const paragraphsOf = (chapter: number) => {
    const end = headings[chapter + 1] ?? content.length
    return Array.from({ length: end - headings[chapter] - 1 }, (_, k) => headings[chapter] + 1 + k).filter(
      (i) => (content[i].content ?? []).map((r) => r.text ?? '').join('').split(' ').length > 25,
    )
  }
  const text = (i: number) => (content[i].content ?? []).map((r) => r.text ?? '').join('')
  return { fx, content, headings, paragraphsOf, text }
}

/** Plain text of each top-level block (deleted text included: it is still in the document). */
async function blocks(page: Page): Promise<string[]> {
  const doc = (await page.evaluate(() => window.__nvE2E.docJSON())) as Json
  const t = (n: Json): string => (n.text ?? '') + (n.content ?? []).map(t).join('')
  return (doc.content ?? []).map(t)
}

/** Text of the runs carrying mark `name`, in document order. */
async function marked(page: Page, name: string): Promise<string[]> {
  const doc = (await page.evaluate(() => window.__nvE2E.docJSON())) as Json
  const out: string[] = []
  const walk = (n: Json) => {
    if (n.text !== undefined && n.marks?.some((m) => m.type === name)) out.push(n.text)
    n.content?.forEach(walk)
  }
  walk(doc)
  return out
}

/**
 * Caret follow: the caret is painted inside the editor's window, and in Book mode its page is on the
 * spread shown (and inside the one-spread window).
 */
async function expectCaretShown(page: Page, where: string) {
  await turnSettled(page)
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const e = window.__nvE2E
          const sel = e.selection()
          if (!sel) return 'no selection'
          const c = e.coordsAt(sel.from)
          if (!c) return 'no caret coords'
          const main = document.querySelector('main')!.getBoundingClientRect()
          if (c.top < main.top - 1 || c.bottom > main.bottom + 1) return `caret at y ${Math.round(c.top)} outside the window ${Math.round(main.top)}..${Math.round(main.bottom)}`
          const book = document.querySelector('.nv-desk[data-navigation="book"]')
          if (book) {
            const l = e.layout()
            if (l.currentPage < l.visibleSpread.first || l.currentPage > l.visibleSpread.last)
              return `caret page ${l.currentPage} not on the spread shown ${l.visibleSpread.first}-${l.visibleSpread.last}`
            const s = document.querySelector('.nv-sizer')!.getBoundingClientRect()
            if (c.top < s.top - 1 || c.bottom > s.bottom + 1) return 'caret outside the spread window'
          }
          return 'ok'
        }),
      { message: `caret shown: ${where}` },
    )
    .toBe('ok')
}

/** Put the caret at the end of top-level block `i` (as a click there would); the view follows it. */
async function caretAtEnd(page: Page, i: number) {
  await page.evaluate((k) => {
    const e = window.__nvE2E
    const end = e.blockPos(k + 1) - 1
    e.selectText(end, end)
  }, i)
  await expectCaretShown(page, `end of block ${i}`)
}

async function reviewMenu(page: Page, id: string) {
  await page.getByRole('menubar', { name: 'Menu bar' }).locator('[data-control-id="menu.review"]').click()
  await page.locator(`[role="menu"] [data-control-id="${id}"]`).click()
}

async function save(page: Page) {
  await editor(page).focus()
  await page.keyboard.press('ControlOrMeta+s')
  await expect(saveStatus(page)).toHaveText(`${TITLE}: Saved`, { timeout: 30_000 })
}

/** Close this window and open the project again from Open Recent (a plain reopen, no crash). */
async function reopen(context: BrowserContext, page: Page): Promise<Page> {
  await page.close()
  const next = await context.newPage()
  await launch(next)
  await openRecent(next, FOLDER)
  await expect(saveStatus(next)).toHaveText(`${TITLE}: All changes saved`, { timeout: 60_000 })
  await waitForLayout(next)
  return next
}

/** Back up the unsaved work now (the 30 s autosave), force-kill, relaunch and restore the backup. */
async function crashAndRestore(context: BrowserContext, page: Page): Promise<Page> {
  await expect(saveStatus(page)).toContainText('Unsaved changes')
  expect(await page.evaluate(() => window.__nvE2E.autosaveNow())).toBe('written')
  await expect(saveStatus(page)).toHaveText(new RegExp(`^${TITLE}: Unsaved changes · backed up \\d`))
  await page.close({ runBeforeUnload: false })
  const next = await context.newPage()
  await launch(next)
  await recoveryControl(next, 'reopen').click()
  await expect(next.getByRole('dialog', { name: 'Restore unsaved changes?' })).toBeVisible()
  await recoveryControl(next, 'restore').click()
  await expect(saveStatus(next)).toContainText(`${TITLE}: Unsaved changes`, { timeout: 60_000 })
  await waitForLayout(next)
  return next
}

/** Page-turn navigation on the long book: Ctrl+End / Ctrl+Home, PageDown / PageUp, the indicator. */
async function checkPageNavigation(page: Page) {
  const pages = (await layout(page)).pageCount
  await editor(page).focus()
  await docEnd(page)
  await expect.poll(async () => (await layout(page)).currentPage).toBe(pages - 1)
  await expect(page.locator(`.nv-frames .nv-page[data-page-index="${pages - 1}"]`)).toBeAttached()
  await expectCaretShown(page, 'Ctrl+End')
  await docStart(page)
  await expect.poll(async () => (await layout(page)).currentPage).toBe(0)
  await expectCaretShown(page, 'Ctrl+Home')
  if (await isBookMode(page)) await expect(indicator(page)).toHaveText(`Page 1 of ${pages}`)
  const before = await indicator(page).textContent()
  await page.keyboard.press('PageDown')
  await expect(indicator(page)).not.toHaveText(before!)
  await expect.poll(async () => (await layout(page)).currentPage).toBeGreaterThan(0)
  await expectCaretShown(page, 'PageDown')
  await page.keyboard.press('PageUp')
  await expect(indicator(page)).toHaveText(before!)
}

test('Phase 3 acceptance: track changes, comments and a re-write on the 100k-word book; each survives save, reopen and recovery', async ({ page: first, context }) => {
  test.setTimeout(600_000)
  let page = first
  const { fx, content, headings, paragraphsOf, text } = fixture()
  await page.setViewportSize({ width: 1400, height: 900 })
  await launch(page)
  await seedProject(page, FOLDER, TITLE, fx.doc)
  await openRecent(page, FOLDER)
  await expect(saveStatus(page)).toHaveText(`${TITLE}: All changes saved`, { timeout: 60_000 })
  await waitForLayout(page)
  expect(await isBookMode(page)).toBe(true)
  await expect(editor(page).locator(':scope > :is(p, h1)')).toHaveCount(content.length)
  expect((await layout(page)).pageCount).toBeGreaterThan(200)
  await checkPageNavigation(page)

  // ---- 1. Track changes, in chapter 12.
  const [i1, i2, i3, i4, i5] = paragraphsOf(11)
  // Recording on from the keyboard (Mod-Shift-e); the ribbon toggle shows it.
  await clickBlockStart(page, editor(page).locator(':scope > h1').nth(11))
  await expectCaretShown(page, 'chapter 12 title clicked')
  await page.keyboard.press('ControlOrMeta+Shift+E')
  await expect(await reveal(page, 'review.track')).toHaveAttribute('aria-pressed', 'true')
  // Two insertions and two deletions in four paragraphs.
  await caretAtEnd(page, i1)
  await page.keyboard.type(' Added by the tester.')
  await caretAtEnd(page, i2)
  for (let k = 0; k < 5; k++) await page.keyboard.press('Backspace')
  await caretAtEnd(page, i3)
  await page.keyboard.type(' Second insert.')
  await caretAtEnd(page, i4)
  for (let k = 0; k < 3; k++) await page.keyboard.press('Backspace')
  await expectCaretShown(page, 'after typing')
  expect(await count(page)).toBe(4)
  await expect(page.getByTestId('changes-indicator')).toHaveText('4 changes')
  expect(await marked(page, 'insertion')).toEqual([' Added by the tester.', ' Second insert.'])
  expect(await marked(page, 'deletion')).toEqual([text(i2).slice(-5), text(i4).slice(-3)])

  // Accept one from its popover (a click on the inserted text).
  await clickBlockStart(page, editor(page).locator('.nv-ins', { hasText: 'Added by the tester.' }))
  await expect(popover(page)).toBeVisible()
  await ctl(popover(page), 'review.popover.accept').click()
  await expect(popover(page)).toHaveCount(0)
  await expect.poll(() => count(page)).toBe(3)
  expect((await blocks(page))[i1]).toBe(`${text(i1)} Added by the tester.`)
  expect(await marked(page, 'insertion')).toEqual([' Second insert.'])

  // Reject one: Next Change from the start of the book turns to it; Review > Reject Change.
  await editor(page).focus()
  await docStart(page)
  await page.keyboard.press('ControlOrMeta+Alt+ArrowDown')
  await expect.poll(async () => (await page.evaluate(() => window.__nvE2E.selection()))!.from).toBeGreaterThan(await page.evaluate((k) => window.__nvE2E.blockPos(k), i2))
  await expectCaretShown(page, 'Next Change')
  await page.keyboard.press('Escape') // a popover, if Next Change opened one
  await reviewMenu(page, 'review.reject')
  await expect.poll(() => count(page)).toBe(2)
  expect(await marked(page, 'deletion')).toEqual([text(i4).slice(-3)])
  expect((await blocks(page))[i2]).toBe(text(i2))

  // Accept All, undone; Reject All, undone.
  await reviewMenu(page, 'review.acceptAll')
  await expect.poll(() => count(page)).toBe(0)
  expect((await blocks(page))[i3]).toBe(`${text(i3)} Second insert.`)
  expect((await blocks(page))[i4]).toBe(text(i4).slice(0, -3))
  await editor(page).focus()
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(() => count(page)).toBe(2)
  await reviewMenu(page, 'review.rejectAll')
  await expect.poll(() => count(page)).toBe(0)
  expect((await blocks(page))[i3]).toBe(text(i3))
  expect((await blocks(page))[i4]).toBe(text(i4))
  await editor(page).focus()
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(() => count(page)).toBe(2)
  await expect(nativeDialog(page)).toHaveCount(0)

  // Save, reopen: the two open changes, recording still on.
  await save(page)
  const manuscript = (await readFile(page, `${FOLDER}/manuscript.json`))!
  expect(manuscript).toContain('"type":"insertion"')
  expect(manuscript).toContain('"type":"deletion"')
  expect(JSON.parse((await readFile(page, `${FOLDER}/book.json`))!).trackChanges).toBe(true)
  page = await reopen(context, page)
  expect(await count(page)).toBe(2)
  expect(await marked(page, 'insertion')).toEqual([' Second insert.'])
  expect(await marked(page, 'deletion')).toEqual([text(i4).slice(-3)])
  expect((await blocks(page))[i1]).toBe(`${text(i1)} Added by the tester.`)
  await expect(await reveal(page, 'review.track')).toHaveAttribute('aria-pressed', 'true')
  await checkPageNavigation(page)
  // An unsaved tracked edit, backed up, then a crash: restored as a change.
  await caretAtEnd(page, i5)
  await page.keyboard.type(' Recovered words.')
  await expect.poll(() => count(page)).toBe(3)
  page = await crashAndRestore(context, page)
  expect(await count(page)).toBe(3)
  expect(await marked(page, 'insertion')).toEqual([' Second insert.', ' Recovered words.'])
  await save(page)

  // ---- 2. Comments, in chapter 20 (recording off from the ribbon toggle).
  await (await reveal(page, 'review.track')).click()
  await expect(await reveal(page, 'review.track')).toHaveAttribute('aria-pressed', 'false')
  const [c1, c2] = paragraphsOf(19)
  await clickBlockStart(page, blockEl(page, c1))
  await expectCaretShown(page, 'comment paragraph clicked')
  const word = text(c1).split(' ')[0]
  await page.evaluate(([k, n]) => {
    const e = window.__nvE2E
    const at = e.blockPos(k) + 1
    e.selectText(at, at + n)
  }, [c1, word.length] as const)
  await page.keyboard.press('ControlOrMeta+Alt+m')
  const field = ctl(page, 'comment.composeField')
  await expect(field).toBeFocused()
  await field.fill('Is this the right word?')
  await page.keyboard.press('ControlOrMeta+Enter')
  await expect(field).toHaveCount(0)
  const card = cards(page)
  await expect(card).toHaveCount(1)
  await expect(editor(page).locator('.nv-comment')).toHaveText(word)
  // Reply, then resolve.
  await ctl(card, 'comment.replyStart').click()
  await ctl(card, 'comment.replyField').fill('Yes, keep it.')
  await ctl(card, 'comment.reply').click()
  await expect(card.locator('[data-testid="comment-text"]')).toHaveText(['Is this the right word?', 'Yes, keep it.'])
  await ctl(card, 'comment.resolve').click()
  await expect(card).toHaveCount(0)
  const thread = (await comments(page)).threads[0] as { id: string; resolved: boolean; messages: unknown[] }
  expect(thread).toMatchObject({ resolved: true, messages: [{ text: 'Is this the right word?' }, { text: 'Yes, keep it.' }] })
  // Save, reopen: resolved with its reply; Show Resolved brings the card back.
  await save(page)
  const savedComments = JSON.parse((await readFile(page, `${FOLDER}/comments.json`))!)
  expect(savedComments.threads).toHaveLength(1)
  expect(savedComments.threads[0]).toMatchObject({ id: thread.id, resolved: true, messages: [{ text: 'Is this the right word?' }, { text: 'Yes, keep it.' }] })
  page = await reopen(context, page)
  expect((await comments(page)).threads).toMatchObject([{ id: thread.id, resolved: true }])
  await clickBlockStart(page, blockEl(page, c1))
  await (await reveal(page, 'comment.showResolved')).click()
  await expect(cards(page)).toHaveCount(1)
  await expect(cards(page)).toContainText('Resolved by')
  await (await reveal(page, 'comment.showResolved')).click()
  // An unsaved second comment, backed up, then a crash.
  await clickBlockStart(page, blockEl(page, c2))
  const word2 = text(c2).split(' ')[0]
  await page.evaluate(([k, n]) => {
    const e = window.__nvE2E
    const at = e.blockPos(k) + 1
    e.selectText(at, at + n)
  }, [c2, word2.length] as const)
  await page.keyboard.press('ControlOrMeta+Alt+m')
  await ctl(page, 'comment.composeField').fill('A second thought.')
  await page.keyboard.press('ControlOrMeta+Enter')
  await expect(cards(page)).toHaveCount(1)
  page = await crashAndRestore(context, page)
  expect((await comments(page)).threads.map((t) => [t.resolved, t.messages.length])).toEqual([
    [true, 2],
    [false, 1],
  ])
  // Next Comment from the start of the book turns to the open one (the resolved one is hidden).
  await editor(page).focus()
  await docStart(page)
  await page.evaluate(() => window.__nvE2E.runCommand('comment.next'))
  await expect.poll(async () => (await page.evaluate(() => window.__nvE2E.selection()))!.from).toBeGreaterThan(await page.evaluate((k) => window.__nvE2E.blockPos(k), c2))
  await expectCaretShown(page, 'Next Comment')
  await expect(cards(page).filter({ hasText: 'A second thought.' })).toBeVisible()
  await save(page)

  // ---- 3. A re-write of one paragraph in chapter 25.
  const [r1, r2] = paragraphsOf(24)
  await clickBlockStart(page, blockEl(page, r1))
  await expectCaretShown(page, 're-write paragraph clicked')
  await page.keyboard.press('ControlOrMeta+Alt+w')
  await expect(rwView(page)).toBeVisible()
  await expect(revision(page)).toBeFocused()
  await page.keyboard.type('Suddenly ')
  await ctl(page, 'rewrite.newVersion').click()
  await revision(page).click()
  await docEnd(page)
  await page.keyboard.type(' It went on all night.')
  await rwView(page).getByRole('tab', { name: 'Version 1' }).click()
  await expect(revision(page)).not.toContainText('It went on all night.')
  await rwView(page).getByRole('tab', { name: 'Version 2' }).click()
  await expect(revision(page)).toContainText('It went on all night.')
  const versions = (await rw(page)).rewrites[0].versions
  expect(versions).toHaveLength(2)
  await ctl(page, 'rewrite.keepVersion').click()
  await expect(rwView(page)).toHaveCount(0)
  await expect(editor(page)).toBeFocused()
  await expectCaretShown(page, 'after Keep This Version')
  const kept = `Suddenly ${text(r1)} It went on all night.`
  expect((await blocks(page))[r1]).toBe(kept)
  // Undo the choice: the original, and the re-write open again with both versions.
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(async () => (await blocks(page))[r1]).toBe(text(r1))
  const back = (await rw(page)).rewrites[0]
  expect(back.status).toBe('open')
  expect(back.versions).toEqual(versions)
  await expect(editor(page).locator('.nv-rw-locked')).toHaveCount(1)
  // Redo: kept again.
  await page.keyboard.press('ControlOrMeta+Shift+z')
  await expect.poll(async () => (await blocks(page))[r1]).toBe(kept)
  expect((await rw(page)).rewrites[0]).toMatchObject({ status: 'resolved', choice: versions[1].id })
  // Save, reopen: the kept text and the resolved re-write with both versions.
  await save(page)
  const savedRewrites = JSON.parse((await readFile(page, `${FOLDER}/rewrites.json`))!)
  expect(savedRewrites.rewrites[0]).toMatchObject({ status: 'resolved', choice: versions[1].id })
  expect(savedRewrites.rewrites[0].versions).toHaveLength(2)
  page = await reopen(context, page)
  expect((await blocks(page))[r1]).toBe(kept)
  expect((await rw(page)).rewrites[0]).toMatchObject({ status: 'resolved', choice: versions[1].id })
  await checkPageNavigation(page)
  // An unsaved second re-write, kept as the original, backed up, then a crash.
  await clickBlockStart(page, blockEl(page, r2))
  await page.keyboard.press('ControlOrMeta+Alt+w')
  await expect(revision(page)).toBeFocused()
  await page.keyboard.type('Quietly, ')
  await ctl(page, 'rewrite.keepOriginal').click()
  await expect(rwView(page)).toHaveCount(0)
  page = await crashAndRestore(context, page)
  expect((await rw(page)).rewrites.map((r) => [r.status, r.choice === 'original'])).toEqual([
    ['resolved', false],
    ['resolved', true],
  ])
  expect((await blocks(page))[r2]).toBe(text(r2))

  // Everything from every step together, after a final save and reopen.
  await save(page)
  page = await reopen(context, page)
  const all = await blocks(page)
  expect(all[r1]).toBe(kept)
  expect(all[i1]).toBe(`${text(i1)} Added by the tester.`)
  expect(await count(page)).toBe(3)
  expect((await comments(page)).threads).toHaveLength(2)
  expect((await rw(page)).rewrites).toHaveLength(2)
  expect(all).toHaveLength(content.length)
  expect(headings.length).toBe(fx.chapters)
})

test('navigation and caret follow on the 100k-word book with changes and comments', async ({ page }, testInfo) => {
  test.setTimeout(300_000)
  const { fx, content, paragraphsOf, text } = fixture()
  // A tracked insertion in chapter 8 and a comment in chapter 22, far apart in the book.
  const [t1] = paragraphsOf(7)
  const [k1] = paragraphsOf(21)
  const stamp = { id: 'acc-i', author: 'Ann', date: '2026-11-01T10:00:00.000Z', authorColor: null }
  content[t1] = { ...content[t1], content: [...(content[t1].content ?? []), { type: 'text', text: ' Tracked words.', marks: [{ type: 'insertion', attrs: stamp }] } as Json] }
  const kText = text(k1)
  const cut = kText.indexOf(' ')
  content[k1] = { type: 'paragraph', content: [{ type: 'text', text: kText.slice(0, cut), marks: [{ type: 'comment', attrs: { id: 'acc-c' } }] }, { type: 'text', text: kText.slice(cut) }] }
  await page.setViewportSize({ width: 1400, height: 900 })
  await launch(page)
  await seedProject(page, '/projects/Nav3', 'Nav3', fx.doc)
  await page.evaluate(() =>
    window.__nvE2E.writeFile(
      '/projects/Nav3/comments.json',
      JSON.stringify({
        version: 1,
        threads: [{ id: 'acc-c', createdAt: '2026-11-01T10:00:00.000Z', author: 'Ann', resolved: false, messages: [{ id: 'm1', author: 'Ann', date: '2026-11-01T10:00:00.000Z', text: 'Far away.' }] }],
      }),
    ),
  )
  await openRecent(page, '/projects/Nav3')
  await expect(saveStatus(page)).toHaveText('Nav3: All changes saved', { timeout: 60_000 })
  await waitForLayout(page)
  expect(await isBookMode(page)).toBe(projectNavigation(testInfo) === 'book')

  await checkPageNavigation(page)
  // Next Change from the start: the caret goes to the change, on the spread shown / in view.
  await docStart(page)
  await page.keyboard.press('ControlOrMeta+Alt+ArrowDown')
  await expect.poll(async () => (await page.evaluate(() => window.__nvE2E.selection()))!.from).toBeGreaterThan(await page.evaluate((k) => window.__nvE2E.blockPos(k), t1))
  await expectCaretShown(page, 'Next Change')
  await page.keyboard.press('Escape')
  // Next Comment: on to chapter 22, its card shown.
  await page.evaluate(() => window.__nvE2E.runCommand('comment.next'))
  await expect.poll(async () => (await page.evaluate(() => window.__nvE2E.selection()))!.from).toBeGreaterThan(await page.evaluate((k) => window.__nvE2E.blockPos(k), k1))
  await expectCaretShown(page, 'Next Comment')
  await expect(cards(page).filter({ hasText: 'Far away.' })).toBeVisible()
  // Typing past the last line of a page: the caret follows onto the next page.
  const l = await layout(page)
  const target = l.pages.find((p) => p.index > 40 && !p.isBlank && l.pages[p.index + 1] && !l.pages[p.index + 1].isBlank && p.index % 2 === 1)!
  // (Shown first, as a writer scrolls or turns there before clicking: a selection set by script does not scroll.)
  await showPage(page, target.index)
  await page.evaluate((pos) => window.__nvE2E.selectText(pos, pos), target.to - 1)
  await expectCaretShown(page, `end of page ${target.index}`)
  await editor(page).focus()
  await page.keyboard.type(' lantern'.repeat(16))
  await waitForLayout(page)
  await expect.poll(async () => (await layout(page)).currentPage).toBeGreaterThan(target.index)
  await expectCaretShown(page, 'typed onto the next page')
  // Arrowing back up over the page top follows too.
  for (let k = 0; k < 4; k++) await page.keyboard.press('ArrowUp')
  await expectCaretShown(page, 'ArrowUp')
  // Go to Page.
  await page.locator('[data-control-id="menu.edit"]').click()
  await page.locator('[role="menu"] [data-control-id="edit.go_to_page"]').click()
  await page.locator('[data-control-id="goToPage.number"]').fill('101')
  await page.keyboard.press('Enter')
  await expect.poll(async () => (await layout(page)).currentPage).toBe(100)
  await expectCaretShown(page, 'Go to Page 101')
})
