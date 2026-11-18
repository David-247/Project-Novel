import { expect, test, type Page } from '@playwright/test'
import { measure, settled, type Probe } from './contrast'
import { editor, launch, lineEnd, lineStart, openRecent, reveal, ribbonTab, saveStatus, seedProject, waitForLayout, writeFile } from './helpers'

/**
 * Phase 3 acceptance, accessibility: WCAG 2.1 AA contrast measured on the rendered UI (computed colours
 * in the real engine), on the four paper surfaces in OS light and dark:
 *  - change marks: inserted, deleted and reformatted text on the paper (4.5:1), and their lines
 *    (underline, strike-through, dotted rule) against the paper (3:1, non-text);
 *  - comment highlights (a thread at rest and the active one): page text on the fill (4.5:1); the cards'
 *    text and buttons on the card (4.5:1);
 *  - re-write differences: page text on the removed / added tints (4.5:1), their lines on the tint
 *    (3:1); the version tabs, labels and Keep buttons;
 *  - the ribbon (tabs, and every tab's controls: text 4.5:1, icon-only by the SVG's stroke / fill 3:1)
 *    and the status bar.
 * Every probe must match (a minimum count each); OS reduced motion is on, and each reading is taken
 * once two readings a frame apart agree (no colour transition running).
 * Disabled controls are exempt (WCAG 1.4.3). The token-level checks stay in the unit tests
 * (track-changes/contrast.test.ts, comments/model.test.ts, rewrite/rewrite.test.tsx).
 */

const SURFACES = ['auto', 'book', 'white', 'dark'] as const
const SCHEMES = ['light', 'dark'] as const
const ctl = (page: Page, id: string) => page.locator(`[data-control-id="${id}"]`)

const RIBBON_TABS = ['home', 'insert', 'layout', 'review', 'view'] as const

const PAGE_PROBES: Probe[] = [
  { what: 'inserted text', sel: '.novel-editor-content .nv-ins' },
  { what: 'inserted text', sel: '.novel-editor-content .nv-ins', kind: 'line' },
  { what: 'deleted text', sel: '.novel-editor-content .nv-del' },
  { what: 'deleted text', sel: '.novel-editor-content .nv-del', kind: 'line' },
  { what: 'reformatted text', sel: '.novel-editor-content .nv-fmt' },
  { what: 'reformatted text', sel: '.novel-editor-content .nv-fmt', kind: 'border' },
  { what: 'comment highlight', sel: '.novel-editor-content .nv-comment[data-comment-id="c1"]' },
  { what: 'active comment highlight', sel: '.novel-editor-content .nv-comment[data-comment-id="c2"]' },
  { what: 'comment card text', sel: '[data-testid="comments-panel"] [data-testid="comment-text"]', bgSel: 'article', all: true, min: 2 },
  { what: 'comment card', sel: '[data-testid="comments-panel"] article[data-thread-id] :is(header, time, span)', bgSel: 'article', all: true, min: 2 },
  { what: 'comment card control', sel: '[data-testid="comments-panel"] article [data-control-id]', bgSel: 'article', kind: 'auto', all: true, min: 4 },
  { what: 'status bar', sel: 'footer[aria-label="Status bar"] [data-control-id], footer[aria-label="Status bar"] [role="status"], [data-testid="changes-indicator"]', kind: 'auto', all: true, min: 4 },
  { what: 'ribbon tab', sel: '[data-control-id^="ribbon.tab."]', all: true, min: 5 },
]

/** The controls of the ribbon tab shown (sampled on each of the five tabs). */
const ribbonProbe = (tab: string): Probe => ({ what: `ribbon ${tab}`, sel: `[data-ribbon-panel="${tab}"] [data-control-id]`, kind: 'auto', all: true, min: 3 })

const REWRITE_PROBES: Probe[] = [
  { what: 're-write removed words', sel: '[data-testid="rewrite-view"] .nv-rw-del' },
  { what: 're-write removed words', sel: '[data-testid="rewrite-view"] .nv-rw-del', kind: 'line' },
  { what: 're-write added words', sel: '[data-testid="rewrite-view"] .nv-rw-ins' },
  { what: 're-write added words', sel: '[data-testid="rewrite-view"] .nv-rw-ins', kind: 'line' },
  { what: 're-write page text', sel: '[data-testid="rewrite-view"] .nv-rw-text p', all: true, min: 2 },
  { what: 're-write label', sel: '[data-testid="rewrite-view"] .nv-rw-label', all: true, min: 2 },
  { what: 're-write control', sel: '[data-testid="rewrite-view"] [data-control-id]', kind: 'auto', all: true, min: 4 },
]


const text = (t: string, marks?: unknown[]) => ({ type: 'text', text: t, ...(marks ? { marks } : {}) })
const stamp = (id: string) => ({ id, author: 'Ann', date: '2026-11-01T10:00:00.000Z', authorColor: null })
const p = (...content: unknown[]) => ({ type: 'paragraph', content })
const thread = (id: string, body: string) => ({
  id,
  createdAt: '2026-11-01T10:00:00.000Z',
  author: 'Test Writer',
  resolved: false,
  messages: [{ id: `${id}-m`, author: 'Test Writer', date: '2026-11-01T10:00:00.000Z', text: body }],
})

test('WCAG AA contrast of the revision tools: four paper surfaces x OS light and dark', async ({ page }) => {
  test.setTimeout(180_000)
  await page.setViewportSize({ width: 1400, height: 900 })
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
  await launch(page)
  const doc = {
    type: 'doc',
    content: [
      { type: 'heading', attrs: { level: 1 }, content: [text('Chapter One')] },
      p(text('The river ran '), text('quietly', [{ type: 'insertion', attrs: stamp('i1') }]), text(' '), text('and slowly', [{ type: 'deletion', attrs: stamp('d1') }]), text(' past the mill. The lantern burned.')),
      p(text('Morning', [{ type: 'comment', attrs: { id: 'c1' } }]), text(' came over the meadow, and the '), text('stranger', [{ type: 'comment', attrs: { id: 'c2' } }]), text(' walked on.')),
      p(text('She closed the window.')),
      p(text('Nobody spoke.')),
    ],
  }
  await seedProject(page, '/projects/Contrast3', 'Contrast3', doc)
  await writeFile(page, '/projects/Contrast3/comments.json', JSON.stringify({ version: 1, threads: [thread('c1', 'At rest.'), thread('c2', 'The active one.')] }))
  await openRecent(page, '/projects/Contrast3')
  await expect(saveStatus(page)).toHaveText('Contrast3: All changes saved')
  await waitForLayout(page)

  // A formatting change: recording on, Bold on "lantern".
  await editor(page).click()
  await page.evaluate(() => window.__nvE2E.setTracking(true))
  await page.evaluate(() => {
    const e = window.__nvE2E
    const at = e.blockPos(1) + 1 + 'The river ran quietly and slowly past the mill. The '.length
    e.selectText(at, at + 'lantern'.length)
  })
  await page.keyboard.press('ControlOrMeta+b')
  await expect(editor(page).locator('.nv-fmt')).toHaveText('lantern')
  await page.evaluate(() => window.__nvE2E.setTracking(false))

  // A re-write of paragraph 3 with added and removed words (then closed: it stays open as a draft).
  await page.evaluate(() => {
    const e = window.__nvE2E
    e.selectText(e.blockPos(3) + 2, e.blockPos(3) + 2)
  })
  await page.keyboard.press('ControlOrMeta+Alt+w')
  const view = page.getByTestId('rewrite-view')
  await expect(view).toBeVisible()
  // Into the revision (a click: the focus hand-over after opening is not what this test is about).
  const revision = page.getByRole('textbox', { name: 'Revised passage' })
  await revision.locator('p').first().click()
  await expect(revision).toBeFocused()
  await lineStart(page)
  await page.keyboard.type('Quietly, ')
  // Remove the paragraph's last words (the end of its last line: no word-jump keys, which differ by OS).
  await lineEnd(page)
  for (let k = 0; k < 12; k++) await page.keyboard.press('Backspace')
  await expect(view.locator('.nv-rw-ins').first()).toBeVisible({ timeout: 10_000 })
  await expect(view.locator('.nv-rw-del').first()).toBeVisible({ timeout: 10_000 })
  await ctl(page, 'rewrite.closeButton').click()
  await expect(view).toHaveCount(0)

  const failures: string[] = []
  let checked = 0
  let lowest = { ratio: Infinity, label: '' }
  const take = (where: string, got: Awaited<ReturnType<typeof measure>>, must: string[]) => {
    for (const m of got.missing) failures.push(`${where} ${m}`)
    for (const e of got.errors) failures.push(`${where} ${e}`)
    for (const w of must) if (!got.samples.some((x) => x.probe === w)) failures.push(`${where}: nothing sampled for ${w}`)
    for (const x of got.samples) {
      checked++
      if (x.ratio / x.min < lowest.ratio) lowest = { ratio: x.ratio / x.min, label: `${where} ${x.what}: ${x.ratio}:1 (min ${x.min}; fg ${x.fg} on ${x.bg})` }
      if (x.ratio < x.min) failures.push(`${where} ${x.what}: ${x.ratio}:1 < ${x.min}:1 (fg ${x.fg} on ${x.bg})`)
    }
  }
  for (const scheme of SCHEMES) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' })
    await expect(page.locator('html')).toHaveAttribute('data-theme', scheme)
    for (const surface of SURFACES) {
      const where = `${scheme}/${surface}`
      await (await reveal(page, `book.surface.${surface}`)).click()
      const resolved = surface === 'auto' ? (scheme === 'light' ? 'white' : 'dark') : surface
      await expect(page.locator('html')).toHaveAttribute('data-surface', resolved)
      // The second thread active (its card clicked), the first at rest.
      await page.locator('[data-testid="comments-panel"] article[data-thread-id="c2"] [data-testid="comment-text"]').click()
      await expect.poll(async () => (await page.evaluate(() => window.__nvE2E.comments())).activeId).toBe('c2')
      take(where, await settled(page, PAGE_PROBES), [
        'inserted text',
        'deleted text',
        'reformatted text',
        'comment highlight',
        'active comment highlight',
        'comment card text',
        'comment card',
        'comment card control',
        'ribbon tab',
        'status bar',
      ])
      // Every ribbon tab's controls.
      for (const tab of RIBBON_TABS) {
        await ribbonTab(page, tab)
        take(`${where} ribbon`, await settled(page, [ribbonProbe(tab)]), [`ribbon ${tab}`])
      }

      // The re-write view, opened again on its draft.
      await editor(page).focus()
      await page.evaluate(() => window.__nvE2E.runCommand('rewrite.next'))
      await expect(view).toBeVisible()
      take(`${where} re-write`, await settled(page, REWRITE_PROBES), ['re-write removed words', 're-write added words', 're-write page text', 're-write label', 're-write control'])
      await ctl(page, 'rewrite.closeButton').click()
      await expect(view).toHaveCount(0)
    }
  }
  console.info(`[phase3 contrast] ${checked} samples checked; lowest (ratio / minimum) ${lowest.ratio.toFixed(2)}: ${lowest.label}`)
  expect(failures).toEqual([])
})
