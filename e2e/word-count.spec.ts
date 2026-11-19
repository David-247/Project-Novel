import { expect, test, type Page } from '@playwright/test'
import { clickBlockStart, editor, launch, lineEnd, openRecent, pressTab, reveal, saveStatus, seedProject, waitForLayout } from './helpers'

/**
 * Live word count (Phase 4, docs/word-count.md): the status bar count ("n words", "n of m words")
 * follows typing and the selection; Review ▸ Word Count (ribbon, Ctrl/Cmd+Shift+G, the status bar)
 * opens the dialog, keyboard only; its counts follow "Include footnotes" and the selection; its text
 * meets AA contrast in light and dark.
 */

const count = (page: Page) => page.getByTestId('word-count')
const dialog = (page: Page) => page.getByRole('dialog', { name: 'Word Count' })
const stat = (page: Page, label: string) => dialog(page).locator(`[data-stat="${label}"]`)

const p = (t: string) => ({ type: 'paragraph', content: [{ type: 'text', text: t }] })
const DOC = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'One' }] },
    // 9 words; the note adds 4.
    { type: 'paragraph', content: [{ type: 'text', text: 'It was a well-known road—long and cold.' }, { type: 'footnote', content: [{ type: 'text', text: 'First told in 1902.' }] }, { type: 'text', text: ' The end' }] },
    p('Second paragraph here.'),
  ],
}
// One + (It was a well-known road—long and cold. The end = 9) + 3 = 13 body words; 17 with the note.

async function open(page: Page, folder = '/projects/Count') {
  await page.setViewportSize({ width: 1280, height: 800 })
  await launch(page)
  await seedProject(page, folder, 'Count', DOC)
  await openRecent(page, folder)
  await expect(saveStatus(page)).toHaveText('Count: All changes saved')
  await waitForLayout(page)
}

const shortcut = process.platform === 'darwin' ? 'Meta+Shift+G' : 'Control+Shift+G'

test('the status bar count follows typing and the selection (no live region)', async ({ page }) => {
  await open(page)
  await expect(count(page)).toHaveText('17 words')
  await expect(page.locator('[data-control-id="wordCount.indicator"]')).not.toHaveAttribute('aria-live')
  expect(await page.locator('[data-control-id="wordCount.indicator"]').evaluate((el) => !!el.closest('[aria-live]'))).toBe(false)

  await clickBlockStart(page, editor(page).locator('p').last())
  await lineEnd(page)
  await page.keyboard.type(' And more')
  await expect(count(page)).toHaveText('19 words')

  // Select "And more" (Shift+Left over 8 characters).
  for (let i = 0; i < 8; i++) await page.keyboard.press('Shift+ArrowLeft')
  await expect(count(page)).toHaveText('2 of 19 words')
  await page.keyboard.press('ArrowRight')
  await expect(count(page)).toHaveText('19 words')
})

test('Word Count dialog: from the shortcut, the ribbon and the status bar; keyboard, tooltips, footnotes, selection', async ({ page }) => {
  await open(page)
  await clickBlockStart(page, editor(page).locator('p').last())

  // Ctrl/Cmd+Shift+G.
  await page.keyboard.press(shortcut)
  await expect(dialog(page)).toBeVisible()
  await expect(stat(page, 'Words')).toHaveText('17')
  await expect(stat(page, 'Paragraphs')).toHaveText('4')
  await expect(stat(page, 'Pages')).not.toHaveText('–')
  const lines = Number(await stat(page, 'Lines').textContent())
  expect(lines).toBeGreaterThanOrEqual(3)

  // Keyboard: Tab reaches the checkbox; Space toggles it; the count leaves the note out.
  const box = dialog(page).getByRole('checkbox', { name: 'Include footnotes' })
  for (let i = 0; i < 4 && !(await box.evaluate((el) => el === document.activeElement)); i++) await pressTab(page)
  await expect(box).toBeFocused()
  // Its tooltip shows on keyboard focus.
  await expect(page.getByRole('tooltip')).toContainText('Count the text of the footnotes too')
  await page.keyboard.press('Space')
  await expect(box).not.toBeChecked()
  await expect(stat(page, 'Words')).toHaveText('13')
  await expect(count(page)).toHaveText('13 words')
  await page.keyboard.press('Space')
  await expect(stat(page, 'Words')).toHaveText('17')

  // Escape closes; the manuscript has the focus again.
  await page.keyboard.press('Escape')
  await expect(dialog(page)).toBeHidden()
  await expect(editor(page)).toBeFocused()

  // Review ▸ Proofing ▸ Word Count (ribbon).
  const button = await reveal(page, 'ribbon.cmd.review.wordCount')
  await button.click()
  await expect(dialog(page)).toBeVisible()
  await dialog(page).getByRole('button', { name: 'Close' }).last().click()
  await expect(dialog(page)).toBeHidden()

  // With a selection: the dialog counts it. The status bar count opens it.
  await clickBlockStart(page, editor(page).locator('p').last())
  for (let i = 0; i < 'Second paragraph'.length; i++) await page.keyboard.press('Shift+ArrowRight')
  await expect(count(page)).toHaveText('2 of 17 words')
  await page.locator('[data-control-id="wordCount.indicator"]').click()
  await expect(dialog(page)).toContainText('Counts of the selected text.')
  await expect(stat(page, 'Words')).toHaveText('2')
  await expect(stat(page, 'Characters (with spaces)')).toHaveText(String('Second paragraph'.length))
  await expect(stat(page, 'Lines')).toHaveText('1')
  await expect(stat(page, 'Pages')).toHaveText('1')
})

test('the count is the text with tracked changes accepted, whatever the markup view', async ({ page }) => {
  const change = { id: 'c1', author: 'Ann', date: '2026-01-01T00:00:00Z' }
  const doc = {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'The ' },
          { type: 'text', text: 'old dusty ', marks: [{ type: 'deletion', attrs: change }] },
          { type: 'text', text: 'new ', marks: [{ type: 'insertion', attrs: change }] },
          { type: 'text', text: 'house' },
        ],
      },
    ],
  }
  await page.setViewportSize({ width: 1280, height: 800 })
  await launch(page)
  await seedProject(page, '/projects/Tracked', 'Tracked', doc)
  await openRecent(page, '/projects/Tracked')
  await expect(saveStatus(page)).toHaveText('Tracked: All changes saved')
  // "The new house" in All Markup (the deleted words are on the page, not in the count).
  await expect(count(page)).toHaveText('3 words')
})

/** WCAG contrast of the dialog's text (rows, labels, checkbox label, buttons) on its surface. */
async function dialogContrast(page: Page) {
  return dialog(page).evaluate((root) => {
    const parse = (c: string) => {
      const m = c.match(/rgba?\(([^)]+)\)/)
      if (!m) return null
      const v = m[1].split(/[ ,/]+/).filter(Boolean).map(Number)
      return [v[0], v[1], v[2], v[3] ?? 1]
    }
    const lum = (rgb: number[]) => {
      const [r, g, b] = rgb.slice(0, 3).map((x) => {
        const s = x / 255
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
      })
      return 0.2126 * r + 0.7152 * g + 0.0722 * b
    }
    const bgOf = (el: Element): number[] => {
      for (let n: Element | null = el; n; n = n.parentElement) {
        const c = parse(getComputedStyle(n).backgroundColor)
        if (c && c[3] >= 1) return c
      }
      return [255, 255, 255, 1]
    }
    const out: { text: string; ratio: number }[] = []
    for (const el of Array.from(root.querySelectorAll('h2, p, th, td, label span, button'))) {
      const text = (el.textContent ?? '').trim()
      if (!text || el.closest('[disabled]')) continue
      const fg = parse(getComputedStyle(el).color)!
      const bg = bgOf(el)
      const mix = fg.slice(0, 3).map((v, i) => v * fg[3] + bg[i] * (1 - fg[3]))
      const [a, b] = [lum(mix), lum(bg)].sort((x, y) => y - x)
      out.push({ text: text.slice(0, 30), ratio: +((a + 0.05) / (b + 0.05)).toFixed(2) })
    }
    return out
  })
}

for (const scheme of ['light', 'dark'] as const) {
  test(`Word Count dialog text meets AA contrast (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' })
    await open(page, `/projects/Contrast-${scheme}`)
    await page.locator('[data-control-id="wordCount.indicator"]').click()
    await expect(dialog(page)).toBeVisible()
    await page.evaluate(() => new Promise((r) => setTimeout(r, 300)))
    const samples = await dialogContrast(page)
    expect(samples.length).toBeGreaterThanOrEqual(12)
    // (The status bar count is sampled by phase3-contrast.spec.ts with every status bar control.)
    for (const s of samples) expect(s.ratio, `"${s.text}"`).toBeGreaterThanOrEqual(4.5)
  })
}
