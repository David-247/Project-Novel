import { expect, type Locator, type Page } from '@playwright/test'

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
  const box = (await main.boundingBox())!
  let p = await point()
  if (p.y < box.y + 40 || p.y > box.y + box.height - 40) {
    await main.evaluate((m, dy) => m.scrollBy(0, dy), p.y - (box.y + box.height / 2))
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0))))
    p = await point()
  }
  await page.mouse.click(p.x, p.y)
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
/** Caret to start / end of the document: Ctrl+Home/End elsewhere; Cmd+Up/Down on macOS. */
export const docStart = (page: Page) => page.keyboard.press(IS_MAC ? 'Meta+ArrowUp' : 'Control+Home')
export const docEnd = (page: Page) => page.keyboard.press(IS_MAC ? 'Meta+ArrowDown' : 'Control+End')
