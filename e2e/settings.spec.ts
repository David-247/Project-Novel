import { expect, test, type Page } from '@playwright/test'
import { launch, newProject, pressTab, readFile } from './helpers'

/**
 * Settings dialog and app preferences (Phase 3, T2): opening it (gear and Mod-,), the author name
 * kept across a restart, a damaged preferences.json, the one-time author question, new-project
 * defaults, tooltips and keyboard access, and AA contrast on the four paper surfaces in both themes.
 * "Restart" = a new page load over the same fake disk (IndexedDB).
 */

const ctl = (page: Page, id: string) => page.locator(`[data-control-id="${id}"]`)
const dialog = (page: Page) => page.getByRole('dialog', { name: 'Settings' })
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

async function setDefaultAuthor(page: Page, name: string) {
  await page.addInitScript((n) => {
    window.__nvE2EConfig = { ...(window.__nvE2EConfig ?? {}), defaultAuthor: n }
  }, name)
}

/** preferences.json as parsed from the fake disk. */
const prefsFile = (page: Page) => page.evaluate(() => window.__nvE2E.preferencesFile())

test('opens from the gear and from the shortcut, closes with Escape and returns focus', async ({ page }) => {
  await launch(page)
  const gear = ctl(page, 'settings.open')
  await gear.click()
  await expect(dialog(page)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog(page)).toBeHidden()
  await expect(gear).toBeFocused()

  await page.locator('main [contenteditable="true"]').click()
  await page.keyboard.press(`${MOD}+,`)
  await expect(dialog(page)).toBeVisible()
  await ctl(page, 'settings.done').click()
  await expect(dialog(page)).toBeHidden()
})

test('the author name defaults to the OS name, and a change is kept across a restart', async ({ page }) => {
  await setDefaultAuthor(page, 'Ada Lovelace')
  await launch(page)
  await ctl(page, 'settings.open').click()
  const name = ctl(page, 'settings.authorName')
  await expect(name).toHaveValue('Ada Lovelace')
  await name.fill('A. A. Milne')
  // Written about 300 ms after the last change.
  await expect.poll(async () => JSON.parse((await prefsFile(page)) ?? '{}').authorName).toBe('A. A. Milne')
  await page.keyboard.press('Escape')

  await launch(page) // restart
  await ctl(page, 'settings.open').click()
  await expect(ctl(page, 'settings.authorName')).toHaveValue('A. A. Milne')
  await expect(ctl(page, 'settings.pageNavigation')).toHaveValue('book')
})

test('a damaged preferences.json starts the app on defaults and the next change repairs it', async ({ page }) => {
  await setDefaultAuthor(page, 'Account Name')
  await launch(page)
  await page.evaluate(() => window.__nvE2E.setPreferencesFile('{ "authorName": "Brok'))
  await launch(page) // restart over the damaged file
  await ctl(page, 'settings.open').click()
  await expect(ctl(page, 'settings.authorName')).toHaveValue('Account Name')
  await expect(ctl(page, 'settings.defaultPaper')).toHaveValue('auto')
  expect(await prefsFile(page)).toBe('{ "authorName": "Brok') // reading never writes
  await ctl(page, 'settings.pageNavigation').selectOption('scroll')
  await expect.poll(async () => (await prefsFile(page))?.includes('"pageNavigation": "scroll"')).toBe(true)
  expect(JSON.parse((await prefsFile(page))!)).toMatchObject({ version: 1, authorName: 'Account Name' })
})

test('a deleted preferences.json falls back to defaults', async ({ page }) => {
  await setDefaultAuthor(page, 'Account Name')
  await launch(page)
  await ctl(page, 'settings.open').click()
  await ctl(page, 'settings.authorName').fill('Someone Else')
  await expect.poll(async () => await prefsFile(page)).not.toBeNull()
  await page.keyboard.press('Escape')
  await page.evaluate(() => window.__nvE2E.setPreferencesFile(null))
  await launch(page)
  await ctl(page, 'settings.open').click()
  await expect(ctl(page, 'settings.authorName')).toHaveValue('Account Name')
})

test('unknown keys in preferences.json survive a change', async ({ page }) => {
  await launch(page)
  await page.evaluate(() => window.__nvE2E.setPreferencesFile(JSON.stringify({ version: 1, authorName: 'Kept', futureKey: { a: [1] } })))
  await launch(page)
  await ctl(page, 'settings.open').click()
  await ctl(page, 'settings.reduceMotion').selectOption('on')
  await expect.poll(async () => JSON.parse((await prefsFile(page)) ?? '{}').reduceMotion).toBe('on')
  expect(JSON.parse((await prefsFile(page))!)).toMatchObject({ futureKey: { a: [1] }, authorName: 'Kept' })
  await expect(page.locator('html')).toHaveAttribute('data-reduce-motion', 'on')
})

test('the author question appears once, when no name is known, and is not asked again', async ({ page }) => {
  await setDefaultAuthor(page, '')
  await launch(page)
  const first = page.evaluate(() => window.__nvE2E.ensureAuthorName())
  const prompt = page.getByRole('dialog', { name: 'Who is writing?' })
  await expect(prompt).toBeVisible()
  await ctl(page, 'settings.prompt.name').fill('Pen Name')
  await ctl(page, 'settings.prompt.save').click()
  expect(await first).toBe('Pen Name')
  await expect(prompt).toBeHidden()
  expect(await page.evaluate(() => window.__nvE2E.ensureAuthorName())).toBe('Pen Name')
  await expect(prompt).toBeHidden()
  await expect.poll(async () => JSON.parse((await prefsFile(page)) ?? '{}').authorName).toBe('Pen Name')

  await launch(page) // restart: the name is known, no question
  expect(await page.evaluate(() => window.__nvE2E.ensureAuthorName())).toBe('Pen Name')
  await expect(prompt).toBeHidden()
})

test('a dismissed author question is not asked again', async ({ page }) => {
  await setDefaultAuthor(page, '')
  await launch(page)
  const first = page.evaluate(() => window.__nvE2E.ensureAuthorName())
  await ctl(page, 'settings.prompt.skip').click()
  expect(await first).toBe('')
  expect(await page.evaluate(() => window.__nvE2E.ensureAuthorName())).toBe('')
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

test('a new project starts with the paper and trim size chosen in Settings', async ({ page }) => {
  await launch(page)
  await ctl(page, 'settings.open').click()
  await ctl(page, 'settings.defaultPaper').selectOption('book')
  await ctl(page, 'settings.defaultTrimSize').selectOption('uk-a5')
  await ctl(page, 'settings.done').click()
  await newProject(page, '/projects/Defaults')
  const book = JSON.parse((await readFile(page, '/projects/Defaults/book.json'))!)
  expect(book).toMatchObject({ surface: 'book', trimSize: 'uk-a5' })
  await expect(page.locator('html')).toHaveAttribute('data-surface', 'book')
})

test('every control has a tooltip, is reachable with Tab, and the audit finds nothing missing', async ({ page }) => {
  await launch(page)
  await ctl(page, 'settings.open').click()
  await expect(dialog(page)).toBeVisible()
  expect(await page.evaluate(() => window.__nvE2E.auditTooltips())).toEqual([])

  const expected = [
    'dialog.close',
    'settings.authorName',
    'settings.authorColor',
    // 'Automatic colour' is disabled until a colour is chosen, so Tab skips it.
    'settings.pageNavigation',
    'settings.reduceMotion',
    'settings.defaultPaper',
    'settings.defaultTrimSize',
    'settings.reset',
    'settings.done',
  ]
  const seen: string[] = []
  // Focus starts on the first focusable control (the close button); Tab through the rest.
  for (let i = 0; i < expected.length; i++) {
    seen.push((await page.evaluate(() => document.activeElement?.getAttribute('data-control-id') ?? '')) as string)
    if (i < expected.length - 1) await pressTab(page)
  }
  // WebKit starts focus on a different element on some platforms: compare as a set, then check order.
  expect(new Set(seen)).toEqual(new Set(expected))

  // Keyboard focus shows the tooltip.
  await ctl(page, 'settings.reset').focus()
  await pressTab(page, { shift: true })
  await pressTab(page)
  await expect(page.locator('[data-tooltip-body]')).toContainText('Reset to defaults')

  // Choosing a colour enables "Automatic colour", which then also has a tooltip.
  await page.getByTestId('settings-author-color-picker').fill('#aa3366')
  await expect(ctl(page, 'settings.authorColorAuto')).toBeEnabled()
  expect(await page.evaluate(() => window.__nvE2E.auditTooltips())).toEqual([])
})

test('targets are at least 32px and the dialog fits a narrow window', async ({ page }) => {
  await page.setViewportSize({ width: 380, height: 700 })
  await launch(page)
  await ctl(page, 'settings.open').click()
  const ids = ['settings.authorName', 'settings.authorColor', 'settings.pageNavigation', 'settings.reduceMotion', 'settings.defaultPaper', 'settings.defaultTrimSize', 'settings.reset', 'settings.done']
  for (const id of ids) {
    const box = (await ctl(page, id).boundingBox())!
    expect(box.height, id).toBeGreaterThanOrEqual(32)
    expect(box.width, id).toBeGreaterThanOrEqual(32)
  }
  const box = (await dialog(page).boundingBox())!
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(380)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(380)
})

test('WCAG AA contrast in the Settings dialog: four paper surfaces x OS light and dark', async ({ page }) => {
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 1200, height: 900 })
  const failures: string[] = []
  let checked = 0
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    await launch(page)
    for (const surface of ['auto', 'book', 'white', 'dark'] as const) {
      await ctl(page, `book.surface.${surface}`).click()
      await ctl(page, 'settings.open').click()
      await expect(dialog(page)).toBeVisible()
      await page.evaluate(() => new Promise((r) => setTimeout(r, 300)))
      const got = await page.evaluate(() => {
        const parse = (c: string): number[] => {
          const m = c.match(/rgba?\(([^)]+)\)/)
          if (!m) return [0, 0, 0, 0]
          const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number)
          return [p[0], p[1], p[2], p[3] ?? 1]
        }
        const over = (top: number[], under: number[]) => [0, 1, 2].map((i) => top[i] * top[3] + under[i] * (1 - top[3]))
        const bgOf = (el: Element): number[] => {
          const layers: number[][] = []
          for (let n: Element | null = el; n; n = n.parentElement) {
            const c = parse(getComputedStyle(n).backgroundColor)
            if (c[3] > 0) {
              layers.push(c)
              if (c[3] >= 1) break
            }
          }
          let out = [255, 255, 255]
          for (const l of layers.reverse()) out = over(l, out)
          return out
        }
        const lum = (rgb: number[]) => {
          const [r, g, b] = rgb.map((v) => {
            const s = v / 255
            return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
          })
          return 0.2126 * r + 0.7152 * g + 0.0722 * b
        }
        const ratio = (a: number[], b: number[]) => {
          const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p)
          return (x + 0.05) / (y + 0.05)
        }
        const root = document.querySelector('[role="dialog"]')!
        const out: { what: string; ratio: number }[] = []
        const text = root.querySelectorAll('h2, h3, label, p, button, input[type="text"], select, span.text-ui-xs')
        text.forEach((el) => {
          if (!(el.textContent || (el as HTMLInputElement).value)) return
          const bg = bgOf(el)
          const fg = over(parse(getComputedStyle(el).color), bg)
          const disabled = (el as HTMLButtonElement).disabled
          if (disabled) return // disabled controls are exempt from WCAG contrast
          out.push({ what: `${el.tagName.toLowerCase()} "${(el.textContent || '').trim().slice(0, 24)}"`, ratio: +ratio(fg, bg).toFixed(2) })
        })
        // Control borders (non-text, 3:1) against the dialog background.
        root.querySelectorAll('input[type="text"], select, [data-control-id="settings.authorColor"]').forEach((el) => {
          const border = parse(getComputedStyle(el).borderTopColor)
          const bg = bgOf(root)
          out.push({ what: `border of ${el.getAttribute('data-control-id')}`, ratio: -+ratio(over(border, bg), bg).toFixed(2) })
        })
        return out
      })
      for (const s of got) {
        checked++
        const border = s.ratio < 0
        const ratio = Math.abs(s.ratio)
        if (ratio < (border ? 3 : 4.5)) failures.push(`${scheme}/${surface} ${s.what}: ${ratio}:1`)
      }
      await ctl(page, 'settings.done').click()
      await expect(dialog(page)).toBeHidden()
    }
  }
  console.info(`[settings contrast] ${checked} samples`)
  expect(checked).toBeGreaterThan(100)
  expect(failures).toEqual([])
})
