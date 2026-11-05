import { expect, type BrowserContext, type Locator, type Page, type TestInfo } from '@playwright/test'

/**
 * Helpers for driving the app through the e2e fake Tauri backend
 * (src/test-utils/e2e-backend.ts). Native-only UI (File menu, folder picker,
 * message boxes) is driven the way a user would see it: menu items fire the
 * same Tauri events, the folder picker returns a pre-chosen folder, and
 * message boxes appear as a `native-dialog` overlay with their buttons.
 */

export const MENU = {
  newProject: 'menu://new-project',
  openProject: 'menu://open-project',
  openRecent: 'menu://open-recent',
  save: 'menu://save',
} as const

export const editor = (page: Page) => page.getByRole('textbox', { name: 'Manuscript' })
export const saveStatus = (page: Page) => page.locator('footer[aria-label="Status bar"] > [role="status"]')
export const nativeDialog = (page: Page) => page.getByTestId('native-dialog')
export const recoveryControl = (page: Page, id: string) => page.locator(`[data-control-id="recovery.${id}"]`)

/** Load (or "relaunch") the app and wait until the editor and fake backend are ready. */
export async function launch(page: Page): Promise<void> {
  // Surface uncaught page errors in the test output (they otherwise only show as their symptoms).
  page.on('pageerror', (e) => console.error(`[pageerror] ${e.message}\n${e.stack ?? ''}`))
  await page.goto('/')
  // CSS, not role: a modal (e.g. the recovery prompt) hides the editor from the a11y tree.
  await expect(page.locator('main [contenteditable="true"]')).toBeVisible()
  await page.waitForFunction(() => !!window.__nvE2E)
}

export async function menu(page: Page, event: string, payload?: unknown): Promise<void> {
  await page.evaluate(([e, p]) => window.__nvE2E.emit(e as string, p), [event, payload] as const)
}

/** File > New Project, choosing `folder` in the (faked) native folder dialog. */
export async function newProject(page: Page, folder: string): Promise<void> {
  await page.evaluate((f) => window.__nvE2E.setNextPick(f), folder)
  await menu(page, MENU.newProject)
  const name = folder.split('/').pop()!
  await expect(saveStatus(page)).toContainText(`${name}:`)
}

/** Save the open project (Mod-s from the manuscript) and wait for "<title>: Saved". */
export async function saveProject(page: Page, title: string): Promise<void> {
  await editor(page).focus()
  await page.keyboard.press('ControlOrMeta+s')
  await expect(saveStatus(page)).toHaveText(`${title}: Saved`, { timeout: 30_000 })
}

/** Close this window and open `folder` again from Open Recent (a plain reopen, no crash); the new page. */
export async function reopenProject(context: BrowserContext, page: Page, folder: string, title: string): Promise<Page> {
  await page.close()
  const next = await context.newPage()
  await launch(next)
  await openRecent(next, folder)
  await expect(saveStatus(next)).toHaveText(`${title}: All changes saved`, { timeout: 60_000 })
  await waitForLayout(next)
  return next
}

/**
 * Back up the unsaved work now (as the 30 s autosave would), force-kill the window, relaunch, and
 * restore the backup from the recovery prompt; the new page, with the restored work unsaved.
 */
export async function crashAndRestore(context: BrowserContext, page: Page, title: string): Promise<Page> {
  await expect(saveStatus(page)).toContainText('Unsaved changes')
  expect(await page.evaluate(() => window.__nvE2E.autosaveNow())).toBe('written')
  await expect(saveStatus(page)).toHaveText(new RegExp(`^${title}: Unsaved changes · backed up \\d`))
  await page.close({ runBeforeUnload: false })
  const next = await context.newPage()
  await launch(next)
  await recoveryControl(next, 'reopen').click()
  await expect(next.getByRole('dialog', { name: 'Restore unsaved changes?' })).toBeVisible()
  await recoveryControl(next, 'restore').click()
  await expect(saveStatus(next)).toContainText(`${title}: Unsaved changes`, { timeout: 60_000 })
  await waitForLayout(next)
  return next
}

/** File > Open Recent > `folder` (must be in the Rust-owned recent list). */
export async function openRecent(page: Page, folder: string): Promise<void> {
  await menu(page, MENU.openRecent, folder)
}

export const readFile = (page: Page, path: string) => page.evaluate((p) => window.__nvE2E.readFile(p), path)
export const writeFile = (page: Page, path: string, contents: string) =>
  page.evaluate(([p, c]) => window.__nvE2E.writeFile(p, c), [path, contents] as const)

/** Write a complete project folder (project.json + manuscript.json) and list it under Open Recent. */
export async function seedProject(
  page: Page,
  folder: string,
  title: string,
  doc: unknown,
  manuscriptText = JSON.stringify(doc),
): Promise<void> {
  const now = new Date(Date.now() - 60_000).toISOString()
  const meta = {
    format: 'novel-project',
    schemaVersion: 1,
    id: `e2e-${title}`,
    title,
    createdAt: now,
    updatedAt: now,
  }
  await writeFile(page, `${folder}/project.json`, JSON.stringify(meta, null, 2))
  await writeFile(page, `${folder}/manuscript.json`, manuscriptText)
  await page.evaluate(([f, t]) => window.__nvE2E.addRecent(f, t), [folder, title] as const)
}

/**
 * Click on the first character of an editor block, as a user would on the page. On paginated pages a
 * block's layout box is not where its lines are painted (a paragraph continued on the next page keeps
 * a tall, partly empty box), so the target is the painted text itself, scrolled into view first.
 * The editor then reads the click's caret now: ProseMirror otherwise picks it up on the async
 * `selectionchange`, and a toolbar select changed right after the click (Playwright's selectOption
 * needs no focus move) could act on the previous selection (seen on macOS CI: the style went to the
 * block at the old caret).
 */
export async function clickBlockStart(page: Page, block: Locator): Promise<void> {
  const point = async () =>
    block.evaluate((el) => {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
      const text = walker.nextNode() as Text | null
      const r = document.createRange()
      if (text && text.length) {
        r.setStart(text, 0)
        r.setEnd(text, 1)
      } else r.selectNodeContents(el)
      const rc = r.getBoundingClientRect()
      return { x: rc.left + Math.min(2, rc.width / 2), y: rc.top + rc.height / 2 }
    })
  const main = page.getByRole('main', { name: 'Editor' })
  // Book mode (the default) shows one spread: turn to the block's spread first.
  if (await isBookMode(page)) {
    await block.evaluate((el) => window.__nvE2E.revealElement(el))
    await turnSettled(page)
  }
  const box = (await main.boundingBox())!
  let p = await point()
  if (p.y < box.y + 40 || p.y > box.y + box.height - 40) {
    await main.evaluate((m, dy) => m.scrollBy(0, dy), p.y - (box.y + box.height / 2))
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0))))
    p = await point()
  }
  await page.mouse.click(p.x, p.y)
  await page.evaluate(() => window.__nvE2E?.syncSelection())
}

/** The writing view is in Book mode (page turns; the default): one spread shown, no scrolling between spreads. */
export async function isBookMode(page: Page): Promise<boolean> {
  return page.evaluate(() => !!document.querySelector('.nv-desk[data-navigation="book"]'))
}

/**
 * Show page `index` in either navigation mode: Book mode turns to its spread, continuous scroll
 * scrolls its row to the top. The caret does not move. Resolves once that spread is painted.
 */
export async function showPage(page: Page, index: number): Promise<void> {
  await page.evaluate((i) => window.__nvE2E.showPage(i), index)
  await turnSettled(page)
  await expect(page.locator(`.nv-frames .nv-page[data-page-index="${index}"]`)).toBeAttached()
}

/**
 * Run `read` on the rendered page frames of the first `rows` spreads and concatenate the results. In
 * continuous scroll the frames near the viewport are rendered at once (read once); in Book mode one
 * spread is, so turn through them (then back to the spread shown before).
 */
export async function acrossSpreads<T>(page: Page, read: () => Promise<T[]>, rows = 4): Promise<T[]> {
  if (!(await isBookMode(page))) return read()
  const start = await page.evaluate(() => window.__nvE2E.layout().visibleSpread.first)
  const out: T[] = []
  await page.evaluate(() => window.__nvE2E.edgeSpread(-1))
  for (let r = 0; r < rows; r++) {
    await turnSettled(page)
    out.push(...(await read()))
    if (!(await page.evaluate(() => window.__nvE2E.turnSpread(1)))) break
  }
  await page.evaluate((i) => window.__nvE2E.showPage(i), start)
  await turnSettled(page)
  return out
}

/** After a page turn: painted, and the turn transition (a short ease-in of the spread) finished. */
export async function turnSettled(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)))
    await Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined)))
  })
}

/**
 * Continuous scroll (the Phase 2 view) for a spec that scrolls through the pages: set the app
 * preference, as Settings > Page navigation would.
 */
export async function chooseScrollNavigation(page: Page): Promise<void> {
  await page.evaluate(() => window.__nvE2E.setPageNavigation('scroll'))
  await expect(page.locator('.nv-desk[data-navigation="scroll"]')).toBeAttached()
}

/**
 * Seed preferences.json for every launch of this page (before the app boots; a file the app wrote
 * since wins). Specs written for continuous scroll, the Phase 2 view, call
 * `seedPreferences(page, { pageNavigation: 'scroll' })` in a beforeEach.
 */
export async function seedPreferences(page: Page, values: Record<string, unknown>): Promise<void> {
  const text = JSON.stringify({ version: 1, ...values })
  await page.addInitScript((t) => {
    ;(window as unknown as { __nvE2EPreferences?: string }).__nvE2EPreferences = t
  }, text)
}

/** The page navigation a Playwright project runs in: 'scroll' for the *-scroll projects, else 'book' (the default). */
export function projectNavigation(testInfo: TestInfo): 'book' | 'scroll' {
  return (testInfo.project.metadata as { pageNavigation?: string } | undefined)?.pageNavigation === 'scroll' ? 'scroll' : 'book'
}

/**
 * For specs that run in both navigation modes (playwright.config.ts BOTH_MODES): call in a
 * beforeEach; the *-scroll projects seed continuous scroll before the app boots.
 */
export async function seedProjectNavigation(page: Page, testInfo: TestInfo): Promise<void> {
  if (projectNavigation(testInfo) === 'scroll') await seedPreferences(page, { pageNavigation: 'scroll' })
}

/** Wait until the pagination engine has laid out the current document (no reflow pending) and painted. */
export async function waitForLayout(page: Page): Promise<void> {
  await page.waitForFunction(() => window.__nvE2E.paginationSettled())
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0))))
  await page.waitForFunction(() => window.__nvE2E.paginationSettled())
}

/**
 * Editor document markup, for content comparisons. Page placement is view state, not content: the
 * pagination offsets (class nv-shift, left/top, data-nv-dy, and the inline wrappers of lines moved
 * to a later page) are removed after the layout settled.
 */
export async function editorHTML(page: Page): Promise<string> {
  await waitForLayout(page)
  return editor(page).evaluate((el) => {
    const copy = el.cloneNode(true) as HTMLElement
    for (const n of Array.from(copy.querySelectorAll<HTMLElement>('.nv-shift'))) {
      if (n.tagName === 'SPAN' && n.attributes.length === 3) {
        n.replaceWith(...Array.from(n.childNodes))
        continue
      }
      n.classList.remove('nv-shift')
      if (!n.classList.length) n.removeAttribute('class')
      n.removeAttribute('data-nv-dy')
      n.style.removeProperty('left')
      n.style.removeProperty('top')
      if (!n.getAttribute('style')) n.removeAttribute('style')
    }
    copy.normalize()
    return copy.innerHTML
  })
}

const IS_MAC = process.platform === 'darwin'
const isWebKit = (page: Page) => page.context().browser()?.browserType().name() === 'webkit'

/**
 * Tab / Shift+Tab focus navigation. WebKit on macOS only tabs between text fields unless the user
 * enabled "Keyboard navigation" (as WKWebView does in the real app); Option+Tab reaches every control.
 */
export async function pressTab(page: Page, opts: { shift?: boolean } = {}): Promise<void> {
  const mods = [IS_MAC && isWebKit(page) ? 'Alt' : null, opts.shift ? 'Shift' : null].filter(Boolean)
  await page.keyboard.press([...mods, 'Tab'].join('+'))
}

/** Caret to start / end of line: Home/End elsewhere; on macOS those scroll, so Cmd+Left/Right. */
export const lineStart = (page: Page) => page.keyboard.press(IS_MAC ? 'Meta+ArrowLeft' : 'Home')
export const lineEnd = (page: Page) => page.keyboard.press(IS_MAC ? 'Meta+ArrowRight' : 'End')
/**
 * Caret to start / end of the document: Ctrl+Home/End elsewhere; Cmd+Up/Down on macOS. The editor
 * then reads the native caret move now (it otherwise waits for the async selectionchange).
 */
export async function docStart(page: Page): Promise<void> {
  await page.keyboard.press(IS_MAC ? 'Meta+ArrowUp' : 'Control+Home')
  await page.evaluate(() => window.__nvE2E?.syncSelection())
}
export async function docEnd(page: Page): Promise<void> {
  await page.keyboard.press(IS_MAC ? 'Meta+ArrowDown' : 'Control+End')
  await page.evaluate(() => window.__nvE2E?.syncSelection())
}

/** Ribbon tab ids (the toolbar shows one tab's controls at a time). */
export type RibbonTab = 'home' | 'insert' | 'layout' | 'review' | 'view'

/**
 * Select a ribbon tab. A click event without moving the pointer: focus, selection and hover stay where
 * the test put them (a real pointer would leave the tab's tooltip open over the row below it).
 */
export async function ribbonTab(page: Page, tab: RibbonTab): Promise<void> {
  const button = page.locator(`[data-control-id="ribbon.tab.${tab}"]`)
  if ((await button.getAttribute('aria-selected')) !== 'true') await button.dispatchEvent('click')
  await expect(button).toHaveAttribute('aria-selected', 'true')
}

/**
 * The ribbon control `id`, with its tab selected first (a control on another tab is mounted but
 * hidden). For controls outside the ribbon it is just the locator.
 */
export async function reveal(page: Page, id: string): Promise<Locator> {
  const tab = await page.evaluate(
    (cid) => document.querySelector(`[data-ribbon-panel] [data-control-id="${cid}"]`)?.closest('[data-ribbon-panel]')?.getAttribute('data-ribbon-panel') ?? null,
    id,
  )
  if (tab) await ribbonTab(page, tab as RibbonTab)
  const control = page.locator(`[data-control-id="${id}"]`)
  if (!tab || (await control.isVisible())) return control
  // The window is too narrow for its group (e.g. Review on macOS at 1280px, whose fonts are wider):
  // open the collapsed group, or More, and return the same command's item in that dropdown.
  const group = await control.evaluate((el) => el.closest('[data-ribbon-group]')?.getAttribute('data-ribbon-group') ?? null)
  const panel = page.locator(`[data-ribbon-panel="${tab}"]`)
  const collapsed = panel.locator(`[data-control-id="ribbon.group.${group}"]`)
  await ((await collapsed.isVisible()) ? collapsed : panel.locator('[data-control-id="ribbon.more"]')).click()
  return page.getByRole('menu').locator(`[data-control-id="${id}"]`)
}
