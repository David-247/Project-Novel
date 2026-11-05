import { expect, test, type Locator, type Page } from '@playwright/test'
import {
  acrossSpreads,
  editor,
  launch,
  lineEnd,
  nativeDialog,
  newProject,
  openRecent,
  recoveryControl,
  reveal,
  saveStatus,
  seedProject,
  turnSettled,
  waitForLayout,
  writeFile,
} from './helpers'

/**
 * Re-write choice (Phase 3, T9): Keep This Version / Keep Original under the pages, one undo reverts
 * a choice (the re-write open again with every version) and redo applies it again; tracked as
 * word-level changes when Track Changes records; chapter titles ask first; running heads and
 * footnote numbers follow; the Re-writes list shows resolved re-writes, which reopen; the choice
 * survives save, reopen and crash recovery.
 */

const ctl = (scope: Page | Locator, id: string) => scope.locator(`[data-control-id="${id}"]`)
const view = (page: Page) => page.getByTestId('rewrite-view')
const original = (page: Page) => page.getByTestId('rewrite-original')
const revision = (page: Page) => page.getByRole('textbox', { name: 'Revised passage' })
const rw = (page: Page) => page.evaluate(() => window.__nvE2E.rewrite())

type Json = { type: string; text?: string; attrs?: Record<string, unknown>; content?: Json[]; marks?: { type: string }[] }
const p = (t: string): Json => ({ type: 'paragraph', content: [{ type: 'text', text: t }] })
const h = (t: string): Json => ({ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: t }] })
const DOC = {
  type: 'doc',
  content: [
    h('The Storm'),
    p('The rain came at dusk, soft at first and then hard against the shutters.'),
    p('She closed the window and listened to the house settle around her.'),
    p('Nobody spoke for a long time.'),
    h('The Flood'),
    p('Water everywhere.'),
  ],
}

async function project(page: Page, name: string, doc: unknown = DOC) {
  await launch(page)
  await newProject(page, `/projects/${name}`)
  await page.evaluate((d) => window.__nvE2E.setDoc(d), doc)
  await waitForLayout(page)
}

/** Select inside blocks a..b of the manuscript, then Re-write Passage… (Mod-Alt-w). */
async function openOn(page: Page, a: number, b: number) {
  await editor(page).click()
  await page.evaluate(async ([x, y]) => {
    const e = window.__nvE2E
    e.selectText(e.blockPos(x) + 3, e.blockPos(y) + 3)
  }, [a, b] as const)
  await page.keyboard.press('ControlOrMeta+Alt+w')
  await expect(view(page)).toBeVisible()
  await expect(revision(page)).toBeFocused()
}

/** Plain text of each top-level block of the manuscript (document model). */
async function blocks(page: Page): Promise<string[]> {
  const doc = (await page.evaluate(() => window.__nvE2E.docJSON())) as Json
  const text = (n: Json): string => (n.type === 'footnote' ? '' : (n.text ?? '') + (n.content ?? []).map(text).join(''))
  return (doc.content ?? []).map(text)
}

/** Text of the manuscript's runs carrying mark `name` (insertion / deletion), in order. */
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

const locked = (page: Page) => editor(page).locator('.nv-rw-locked')

test('acceptance path: toggle versions, keep one; one undo restores the original and the open re-write with every version; redo again', async ({ page }) => {
  await project(page, 'Choice')
  await openOn(page, 1, 1)
  // Version 1: a word added at the start. Version 2 (a copy), with more.
  await page.keyboard.type('Suddenly ')
  await ctl(page, 'rewrite.newVersion').click()
  await revision(page).click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.type(' It went on all night.')
  // Toggle between them.
  await view(page).getByRole('tab', { name: 'Version 1' }).click()
  await expect(revision(page)).not.toContainText('all night')
  await view(page).getByRole('tab', { name: 'Version 2' }).click()
  await expect(revision(page)).toContainText('It went on all night.')
  // The choice: large labelled buttons under each page.
  await expect(ctl(page, 'rewrite.keepOriginal')).toBeVisible()
  await expect(ctl(page, 'rewrite.keepVersion')).toBeVisible()
  // And in the ribbon (Review > Re-write) while the re-write is open.
  await expect(ctl(page, 'ribbon.cmd.rewrite.keepVersion')).toHaveCount(1)
  await expect(ctl(page, 'ribbon.cmd.rewrite.keepOriginal')).toBeEnabled()
  expect(await page.evaluate(() => window.__nvE2E.auditTooltips())).toEqual([])
  const versions = (await rw(page)).rewrites[0].versions
  await ctl(page, 'rewrite.keepVersion').click()

  // Back in the manuscript: updated, caret at the start of the passage, nothing locked.
  await expect(view(page)).toHaveCount(0)
  await expect(editor(page)).toBeFocused()
  await expect(ctl(page, 'ribbon.cmd.rewrite.keepVersion')).toHaveCount(0)
  const kept = 'Suddenly The rain came at dusk, soft at first and then hard against the shutters. It went on all night.'
  expect((await blocks(page))[1]).toBe(kept)
  await expect(editor(page).locator('p').first()).toHaveText(kept)
  expect((await page.evaluate(() => window.__nvE2E.selection()))!.from).toBe((await page.evaluate(() => window.__nvE2E.blockPos(1))) + 1)
  const after = (await rw(page)).rewrites[0]
  expect(after).toMatchObject({ status: 'resolved', choice: versions[1].id })
  await expect(locked(page)).toHaveCount(0)

  // One undo: the original text, the re-write open with both versions, the passage locked again.
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(async () => (await blocks(page))[1]).toBe(DOC.content[1].content![0].text)
  const back = (await rw(page)).rewrites[0]
  expect(back.status).toBe('open')
  expect(back.versions).toEqual(versions)
  await expect(locked(page)).toHaveCount(1)
  // Redo: kept again.
  await page.keyboard.press('ControlOrMeta+Shift+z')
  await expect.poll(async () => (await blocks(page))[1]).toBe(kept)
  expect((await rw(page)).rewrites[0].status).toBe('resolved')
  await expect(locked(page)).toHaveCount(0)
  await waitForLayout(page)
  // Typing goes on in the manuscript; it is not part of the Keep's undo step.
  await page.keyboard.type('Then ')
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(async () => (await blocks(page))[1]).toBe(kept)
  expect((await rw(page)).rewrites[0].status).toBe('resolved')
})

test('Keep Original (keyboard) records the choice; the Re-writes list shows it; Reopen compares the text now with the saved versions', async ({ page }) => {
  await project(page, 'Original')
  await openOn(page, 2, 3)
  await page.keyboard.type('Quietly, ')
  // By keyboard: the button is reachable (no default shortcut).
  await ctl(page, 'rewrite.keepOriginal').focus()
  await page.keyboard.press('Enter')
  await expect(view(page)).toHaveCount(0)
  expect((await blocks(page)).slice(2, 4)).toEqual([DOC.content[2].content![0].text, DOC.content[3].content![0].text])
  expect((await rw(page)).rewrites[0]).toMatchObject({ status: 'resolved', choice: 'original' })

  // The text changed since: Reopen still finds it, and shows it as the original.
  await editor(page).locator('p').nth(2).click()
  await lineEnd(page)
  await page.keyboard.type(' Ever.')
  await page.evaluate(() => window.__nvE2E.runCommand('rewrite.list'))
  const list = page.getByRole('dialog', { name: 'Re-writes' })
  const resolved = list.getByTestId('rewrite-list-resolved')
  await expect(resolved.locator('li')).toHaveCount(1)
  await expect(resolved).toContainText('Kept the original. 1 version')
  expect(await page.evaluate(() => window.__nvE2E.auditTooltips())).toEqual([])
  await ctl(list, 'rewrite.listReopen').click()
  await expect(view(page)).toBeVisible()
  await expect(original(page)).toContainText('Nobody spoke for a long time. Ever.')
  await expect(revision(page)).toContainText('Quietly, She closed the window')
  expect((await rw(page)).rewrites[0].status).toBe('open')
  // Locked again (the manuscript is hidden from the accessibility tree behind the view).
  await expect(page.locator('.nv-rw-locked')).toHaveCount(2)
  // Change of mind: keep the version now (keyboard). The closed list first returns the focus (via the hidden
  // manuscript, which hands it to the revision) a moment after it is gone: let that settle, then Tab-like focus.
  await expect(list).toHaveCount(0)
  await expect(revision(page)).toBeFocused()
  await page.evaluate(() => new Promise((r) => setTimeout(r, 100)))
  await expect(revision(page)).toBeFocused()
  await ctl(page, 'rewrite.keepVersion').focus()
  await expect(ctl(page, 'rewrite.keepVersion')).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(view(page)).toHaveCount(0)
  expect((await blocks(page))[2]).toBe('Quietly, She closed the window and listened to the house settle around her.')
  // The Ever. typed after Keep Original is replaced by the version's text (the version was made before it).
  expect((await blocks(page))[3]).toBe('Nobody spoke for a long time.')
})

test('with Track Changes on, a kept version is word-level tracked changes that accept / reject handle', async ({ page }) => {
  await project(page, 'Tracked')
  await page.evaluate(() => window.__nvE2E.setTracking(true))
  await openOn(page, 1, 1)
  // "dusk" -> "night".
  await page.keyboard.press('ControlOrMeta+Home')
  for (let i = 0; i < 'The rain came at '.length; i++) await page.keyboard.press('ArrowRight')
  for (let i = 0; i < 4; i++) await page.keyboard.press('Shift+ArrowRight')
  await page.keyboard.type('night')
  await ctl(page, 'rewrite.keepVersion').click()
  await expect(view(page)).toHaveCount(0)
  expect(await marked(page, 'deletion')).toEqual(['dusk'])
  expect(await marked(page, 'insertion')).toEqual(['night'])
  expect(await page.evaluate(() => window.__nvE2E.countChanges())).toBeGreaterThanOrEqual(1)
  // Reject all: the original. Undo, accept all: the version.
  await page.evaluate(() => window.__nvE2E.resolveAllChanges('reject'))
  expect((await blocks(page))[1]).toBe(DOC.content[1].content![0].text)
  await editor(page).click()
  await page.keyboard.press('ControlOrMeta+z')
  await page.evaluate(() => window.__nvE2E.resolveAllChanges('accept'))
  expect((await blocks(page))[1]).toBe('The rain came at night, soft at first and then hard against the shutters.')
})

/** Long chapters (several pages each) and running heads showing the chapter title. */
function bookDoc() {
  const long = (i: number) =>
    p(`${i}. The lantern swung over the harbor wall while the boats came in one by one, their sails grey with salt and their crews too tired to sing the old songs.`)
  const withNote = (t: string, note: string): Json => ({
    type: 'paragraph',
    content: [{ type: 'text', text: t }, { type: 'footnote', content: [{ type: 'text', text: note }] }, { type: 'text', text: ' And then it was over.' }],
  })
  return {
    type: 'doc',
    content: [h('The Storm'), ...Array.from({ length: 14 }, (_, i) => long(i)), withNote('The first note is here.', 'Note A.'), withNote('The second note is here.', 'Note B.'), h('The Flood'), ...Array.from({ length: 14 }, (_, i) => long(i))],
  }
}

/** The running heads of the first spreads (Book mode, the default, paints one spread: turn through them). */
async function headers(page: Page): Promise<string[]> {
  await waitForLayout(page)
  return acrossSpreads(page, () =>
    page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>('.nv-frames .nv-page [data-hf-region="header"] [data-hf="text"]'), (e) => e.textContent ?? '')),
  )
}

test('chapter title: a renamed title updates the running heads; removing one asks first; footnote numbers follow', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  await launch(page)
  await seedProject(page, '/projects/Heads', 'Heads', bookDoc())
  await writeFile(page, '/projects/Heads/book.json', JSON.stringify({ format: 'novel-book', version: 1, headerFooter: { verso: { kind: 'chapter', text: '' }, recto: { kind: 'chapter', text: '' } } }))
  await openRecent(page, '/projects/Heads')
  await expect(saveStatus(page)).toHaveText('Heads: All changes saved')
  await waitForLayout(page)
  expect(await headers(page)).toContain('The Storm')

  // Rename the title in a re-write of the title and the first paragraph.
  await openOn(page, 0, 1)
  await page.keyboard.press('ControlOrMeta+Home')
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowRight')
  await page.keyboard.type('Great ')
  await ctl(page, 'rewrite.keepVersion').click()
  await expect(view(page)).toHaveCount(0)
  await expect(nativeDialog(page)).toHaveCount(0)
  await expect.poll(() => headers(page)).toContain('The Great Storm')
  expect(await headers(page)).not.toContain('The Storm')

  // A version that drops the first footnote: the second one becomes number 1.
  expect((await page.evaluate(() => window.__nvE2E.footnotes())).map((f) => [f.label, f.text])).toEqual([
    ['1', 'Note A.'],
    ['2', 'Note B.'],
  ])
  await openOn(page, 15, 15)
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.type('No note any more.')
  await ctl(page, 'rewrite.keepVersion').click()
  await expect(view(page)).toHaveCount(0)
  await waitForLayout(page)
  expect((await page.evaluate(() => window.__nvE2E.footnotes())).map((f) => [f.label, f.text])).toEqual([['1', 'Note B.']])

  // A version where the second chapter's title is body text: asks first; Cancel changes nothing.
  const titleIndex = (await blocks(page)).indexOf('The Flood')
  await openOn(page, titleIndex, titleIndex + 1)
  await page.keyboard.press('ControlOrMeta+Home')
  await (await reveal(page, 'styles.picker')).selectOption('body')
  await expect(revision(page).locator('h1')).toHaveCount(0)
  await ctl(page, 'rewrite.keepVersion').click()
  await expect(nativeDialog(page)).toContainText('The Flood')
  await nativeDialog(page).getByRole('button', { name: 'Cancel' }).click()
  await expect(view(page)).toBeVisible()
  expect((await rw(page)).rewrites.find((r) => r.status === 'open')).toBeTruthy()
  await ctl(page, 'rewrite.keepVersion').click()
  await nativeDialog(page).getByRole('button', { name: 'Keep This Version' }).click()
  await expect(view(page)).toHaveCount(0)
  await expect(editor(page).locator('h1')).toHaveCount(1)
})

test('the choice and the history survive save, reopen and crash recovery', async ({ page, context }) => {
  await page.clock.install()
  await project(page, 'Saved')
  await openOn(page, 1, 1)
  await page.keyboard.type('Kept words. ')
  await ctl(page, 'rewrite.keepVersion').click()
  await expect(view(page)).toHaveCount(0)
  await page.keyboard.press('ControlOrMeta+s')
  await expect(saveStatus(page)).toHaveText('Saved: Saved')
  const saved = JSON.parse((await page.evaluate(() => window.__nvE2E.readFile('/projects/Saved/rewrites.json')))!)
  expect(saved.rewrites[0]).toMatchObject({ status: 'resolved', choice: saved.rewrites[0].versions[0].id })
  expect(saved.rewrites[0].resolvedAt).toBeTruthy()
  // Resolved: no anchor left in manuscript.json.
  expect((await page.evaluate(() => window.__nvE2E.readFile('/projects/Saved/manuscript.json')))!).not.toContain('rewriteId')

  // A second re-write kept as original, unsaved, backed up by autosave, then a crash.
  await openOn(page, 3, 3)
  await ctl(page, 'rewrite.keepOriginal').click()
  await expect(view(page)).toHaveCount(0)
  await expect(saveStatus(page)).toContainText('Unsaved changes')
  await page.clock.runFor(31_000)
  await expect(saveStatus(page)).toHaveText(/^Saved: Unsaved changes · backed up \d/)
  await page.close({ runBeforeUnload: false })

  const relaunched = await context.newPage()
  await launch(relaunched)
  await recoveryControl(relaunched, 'reopen').click()
  await recoveryControl(relaunched, 'restore').click()
  await expect(editor(relaunched)).toContainText('Kept words. The rain came')
  await expect.poll(async () => (await rw(relaunched)).rewrites.map((r) => [r.status, r.choice === 'original'])).toEqual([
    ['resolved', false],
    ['resolved', true],
  ])
  await relaunched.keyboard.press('ControlOrMeta+s')
  await expect(saveStatus(relaunched)).toHaveText('Saved: Saved')

  // A plain reopen: both in the list, under Resolved.
  await relaunched.close({ runBeforeUnload: false })
  const third = await context.newPage()
  await launch(third)
  await openRecent(third, '/projects/Saved')
  await expect(saveStatus(third)).toHaveText('Saved: All changes saved')
  await waitForLayout(third)
  await third.evaluate(() => window.__nvE2E.runCommand('rewrite.list'))
  const list = third.getByRole('dialog', { name: 'Re-writes' })
  await expect(list.getByTestId('rewrite-list-resolved').locator('li')).toHaveCount(2)
  await expect(list.getByTestId('rewrite-list-resolved')).toContainText('Kept Version 1')
})

test('AltGr chords type characters in the view: they never keep, discard or flip', async ({ page }) => {
  await project(page, 'AltGr')
  await openOn(page, 1, 1)
  // AltGr+Shift+O (Polish Ó) and AltGr+K: Ctrl+Alt on Windows, with the AltGraph modifier state.
  const altGr = (key: string, code: string, shift: boolean) =>
    revision(page).evaluate(
      (el, [k, c, s]) => {
        const init = { key: k as string, code: c as string, ctrlKey: true, altKey: true, shiftKey: s as boolean, bubbles: true, cancelable: true, modifierAltGraph: true }
        el.dispatchEvent(new KeyboardEvent('keydown', init as KeyboardEventInit))
      },
      [key, code, shift] as const,
    )
  await page.keyboard.press('ControlOrMeta+Home')
  await altGr('\u00d3', 'KeyO', true)
  await page.keyboard.insertText('\u00d3')
  await altGr('\u00d5', 'KeyV', true)
  await altGr('\u0138', 'KeyK', false)
  await expect(revision(page)).toContainText('\u00d3The rain came')
  await expect(view(page)).toBeVisible()
  const r = await rw(page)
  expect(r.rewrites[0].status).toBe('open')
  await expect(view(page).locator('.nv-rw-spread')).not.toHaveAttribute('data-flipped')
  // The real Flip shortcut still works.
  await page.keyboard.press('ControlOrMeta+Alt+k')
  await expect(view(page).locator('.nv-rw-spread')).toHaveAttribute('data-flipped', 'true')
})

test('Discard: a notice offers undo, which brings the re-write back', async ({ page }) => {
  await project(page, 'Discard')
  await openOn(page, 1, 1)
  await page.keyboard.type('Gone ')
  await ctl(page, 'rewrite.discard').click()
  await expect(view(page)).toHaveCount(0)
  await expect(page.getByTestId('rewrite-notice')).toContainText('Re-write discarded. Undo')
  expect((await rw(page)).rewrites).toHaveLength(0)
  await expect(locked(page)).toHaveCount(0)
  await editor(page).click()
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(async () => (await rw(page)).rewrites.length).toBe(1)
  expect(JSON.stringify((await rw(page)).rewrites[0].versions[0].doc)).toContain('Gone The rain')
  await expect(locked(page)).toHaveCount(1)
})

test('Space on the focused Keep This Version button keeps the version (keyboard activation)', async ({ page }) => {
  // Runs on both engines. (An earlier WebKit failure of a Space press was the test focusing the button in
  // the frame right after the view opened, when the view still moves the focus to the revision: wait for
  // the focus to settle before pressing, as below.)
  await project(page, 'Space')
  await openOn(page, 1, 1)
  await page.keyboard.type('Briefly, ')
  await ctl(page, 'rewrite.keepVersion').focus()
  await expect(ctl(page, 'rewrite.keepVersion')).toBeFocused()
  await page.keyboard.press('Space')
  await expect(view(page)).toHaveCount(0)
  expect((await blocks(page))[1]).toMatch(/^Briefly, The rain came/)
  expect((await rw(page)).rewrites[0].status).toBe('resolved')
})

test("Book mode: Keep and Reopen show the passage's spread; after Keep or Discard closes the view, the pages turn again (PageUp / PageDown, wheel, turns)", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  const long = (i: number) => p(`${i}. The river ran on past the mill and the bridge and the quiet houses by the water. `.repeat(10).trim())
  await project(page, 'BookTurns', { type: 'doc', content: [h('One'), ...Array.from({ length: 30 }, (_, i) => long(i))] })
  await expect(page.locator('.nv-desk[data-navigation="book"]')).toHaveCount(1)
  const state = () =>
    page.evaluate(() => {
      const l = window.__nvE2E.layout()
      const sel = window.__nvE2E.selection()!
      const pg = l.pages.findIndex((x, i) => sel.from >= x.from && (sel.from < x.to || i === l.pages.length - 1))
      return { page: pg, first: l.visibleSpread.first, last: l.visibleSpread.last, index: l.visibleSpread.index }
    })
  const caretShown = async () => {
    const s = await state()
    return s.page >= s.first && s.page <= s.last
  }
  const spread = async () => (await state()).index
  const main = page.getByRole('main', { name: 'Editor' })
  /** With the view closed: PageDown / PageUp with the focus outside the manuscript, the wheel and direct turns all turn. */
  const turnsWork = async () => {
    await expect(view(page)).toHaveCount(0)
    await page.evaluate(() => window.__nvE2E.edgeSpread(-1))
    await turnSettled(page)
    expect(await spread()).toBe(0)
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await page.keyboard.press('PageDown')
    await expect.poll(spread).toBe(1)
    await turnSettled(page)
    await page.keyboard.press('PageUp')
    await expect.poll(spread).toBe(0)
    await turnSettled(page)
    const box = (await main.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.wheel(0, 400)
    await expect.poll(spread).toBe(1)
    await turnSettled(page)
    expect(await page.evaluate(() => window.__nvE2E.turnSpread(1))).toBe(true)
    await expect.poll(spread).toBe(2)
  }

  // Keep This Version deep in the book: back on the passage's spread, then the pages turn.
  await openOn(page, 20, 21)
  await page.keyboard.type('Kept. ')
  await ctl(page, 'rewrite.keepVersion').click()
  await expect(view(page)).toHaveCount(0)
  await expect.poll(caretShown).toBe(true)
  const kept = await state()
  expect(kept.index).toBeGreaterThan(0)
  expect((await blocks(page))[20]).toMatch(/^Kept\. 19\. The river/)
  await turnsWork()

  // Reopen from the Re-writes list while the first spread is shown: the manuscript behind the view
  // turns to the passage, so the choice comes back to it.
  await page.evaluate(() => window.__nvE2E.edgeSpread(-1))
  await turnSettled(page)
  expect(await spread()).toBe(0)
  await page.evaluate(() => window.__nvE2E.runCommand('rewrite.list'))
  const list = page.getByRole('dialog', { name: 'Re-writes' })
  await ctl(list, 'rewrite.listReopen').click()
  await expect(view(page)).toBeVisible()
  await expect.poll(spread).toBe(kept.index)
  // Keep Original: the view closes on the passage's spread; the pages turn again.
  await expect(list).toHaveCount(0)
  await ctl(page, 'rewrite.keepOriginal').click()
  await expect(view(page)).toHaveCount(0)
  await expect.poll(caretShown).toBe(true)
  expect(await spread()).toBe(kept.index)
  await turnsWork()

  // Discard Re-write on another passage: the view closes; the pages turn again.
  await openOn(page, 25, 25)
  await ctl(page, 'rewrite.discard').click()
  await expect(view(page)).toHaveCount(0)
  await expect.poll(caretShown).toBe(true)
  await turnsWork()
})
