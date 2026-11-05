import { expect, test, type Page } from '@playwright/test'
import { editor, launch, openRecent, saveStatus, seedProject, waitForLayout } from './helpers'

/**
 * The status bar keeps one row (T6): at narrow widths low-priority items hide (container queries on the
 * footer) instead of being clipped. Every visible control sits fully inside the footer, and nothing the
 * user cannot see can take keyboard focus.
 */

const footer = (page: Page) => page.locator('footer[aria-label="Status bar"]')

/** Problems: controls that are visible but not fully inside the footer, or hidden yet focusable. */
const problems = (page: Page) =>
  footer(page).evaluate((bar) => {
    const box = bar.getBoundingClientRect()
    const out: string[] = []
    const focusable = bar.querySelectorAll<HTMLElement>('button, select, input, a[href], [tabindex]:not([tabindex="-1"])')
    for (const el of focusable) {
      const name = el.getAttribute('data-control-id') ?? el.getAttribute('aria-label') ?? el.textContent?.trim()
      if (!el.checkVisibility()) {
        el.focus()
        if (document.activeElement === el) out.push(`hidden but focusable: ${name}`)
        continue
      }
      const r = el.getBoundingClientRect()
      if (r.left < box.left - 0.5 || r.right > box.right + 0.5 || r.top < box.top - 0.5 || r.bottom > box.bottom + 0.5) {
        out.push(`clipped: ${name} [${Math.round(r.left)}..${Math.round(r.right)}] in [${Math.round(box.left)}..${Math.round(box.right)}]`)
      }
    }
    // Text items (save status, page indicator) may truncate, but no item may poke out of the bar.
    if (bar.scrollWidth > bar.clientWidth + 1) out.push(`row overflows: ${bar.scrollWidth} > ${bar.clientWidth}`)
    return out
  })

async function check(page: Page, label: string) {
  const height = (await footer(page).boundingBox())!.height
  for (const width of [800, 600, 480]) {
    await page.setViewportSize({ width, height: 700 })
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
    expect(await problems(page), `${label} at ${width}px`).toEqual([])
    expect((await footer(page).boundingBox())!.height, `${label} at ${width}px: one row`).toBe(height)
  }
}

test('no project (with unsaved text): New / Open / Save as project stay whole, as icons when narrow', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 700 })
  await launch(page)
  await editor(page).click()
  await page.keyboard.type('Some unsaved words.')
  await expect(page.locator('footer [data-control-id="file.save"]')).toBeVisible()
  await check(page, 'no project')
  // At 480 the three project buttons are icons with their names, and the zoom menu is still there.
  for (const [id, name] of [
    ['file.save', 'Save as project…'],
    ['file.new_project', 'New project…'],
    ['file.open_project', 'Open project…'],
  ]) {
    const b = page.locator(`footer [data-control-id="${id}"]`)
    await expect(b).toBeVisible()
    await expect(b).toHaveAccessibleName(name)
  }
  await expect(page.locator('footer [data-control-id="pagination.zoom"]')).toBeVisible()
  await expect(page.locator('footer [data-control-id="pagination.zoomIn"]')).toBeHidden()
})

test('a project open: page indicator shortens then hides, zoom keeps its menu', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 700 })
  await launch(page)
  const text = (s: string) => ({ type: 'text', text: s })
  const content = Array.from({ length: 30 }, (_, i) => ({ type: 'paragraph', content: [text(`Paragraph ${i + 1} of a short book. `.repeat(12))] }))
  await seedProject(page, '/projects/A rather long project title for the status bar', 'A rather long project title for the status bar', { type: 'doc', content })
  await openRecent(page, '/projects/A rather long project title for the status bar')
  await expect(saveStatus(page)).toContainText('All changes saved')
  await waitForLayout(page)
  await expect(page.getByTestId('page-indicator')).toBeVisible()
  await check(page, 'project open')
  await page.setViewportSize({ width: 700, height: 700 })
  await expect(page.getByTestId('page-indicator')).toBeHidden()
  await expect(footer(page).getByText(/^\d+ \/ \d+$/)).toBeVisible()
  await page.setViewportSize({ width: 480, height: 700 })
  await expect(footer(page).getByText(/^\d+ \/ \d+$/)).toBeHidden()
  await expect(page.locator('footer [data-control-id="pagination.zoom"]')).toBeVisible()
  // The save status truncates (full text on hover) rather than pushing the zoom menu out.
  await expect(saveStatus(page)).toHaveAttribute('title', /A rather long project title/)
})

test('tracked changes: the "N changes" count stays whole, as just the number when narrow', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 700 })
  await launch(page)
  const text = (s: string, marks?: unknown[]) => ({ type: 'text', text: s, ...(marks ? { marks } : {}) })
  const ins = (id: string) => [{ type: 'insertion', attrs: { id, author: 'Ann', date: new Date().toISOString(), authorColor: null } }]
  const content = Array.from({ length: 12 }, (_, i) => ({
    type: 'paragraph',
    content: [text(`Paragraph ${i + 1} of a short book. `.repeat(6)), text('added', ins(`c${i}`))],
  }))
  await seedProject(page, '/projects/A rather long project title with changes', 'A rather long project title with changes', { type: 'doc', content })
  await openRecent(page, '/projects/A rather long project title with changes')
  await expect(saveStatus(page)).toContainText('All changes saved')
  await waitForLayout(page)
  const count = page.getByTestId('changes-indicator')
  await expect(count).toHaveText('12 changes')
  await check(page, 'with changes')
  // 480 (the last width of check): the number only; its name and tooltip still say what it is.
  await expect(count).toBeVisible()
  await expect(count).toHaveAccessibleName('12 changes. Go to the next change')
  expect(await count.evaluate((el) => (el as HTMLElement).innerText.trim())).toBe('12')
  await page.setViewportSize({ width: 800, height: 700 })
  await expect.poll(() => count.evaluate((el) => (el as HTMLElement).innerText.trim())).toBe('12 changes')
})
