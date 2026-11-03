import { expect, type Page } from '@playwright/test'

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

/** Editor document as ProseMirror-ish text blocks, for content comparisons. */
export const editorHTML = (page: Page) => editor(page).evaluate((el) => el.innerHTML)
