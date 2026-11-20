import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { settled, type Probe } from './contrast'
import { clickBlockStart, editor, launch, openRecent, pressTab, saveStatus, seedProject, seedProjectNavigation, waitForLayout } from './helpers'

/**
 * The AI tutor panel (Phase 5 T9), through the e2e fake provider (window.__nvE2E.tutorQueue: each queued
 * reply answers one model call as an OpenAI stream, through the real adapter, the fetch shim and the
 * fake core's ai_fetch). Runs on all four pairs (Book and continuous scroll, chromium and webkit):
 *  - the flow: Ctrl/Cmd+Shift+Y opens the panel, + attaches the page, nothing reaches ai_fetch before
 *    send, the tutor explains the flagged word and lists the correction, Fix applies it;
 *  - the overlay below 768 px, Escape;
 *  - audits: the tooltip audit, keyboard reachability (Tab through the panel, each control with a
 *    focus ring), WCAG AA contrast of the panel in OS light and dark;
 *  - screenshots of the panel for the report (chromium, Book mode only).
 */

const FOLDER = '/projects/Tutor'
const TITLE = 'Tutor'
const para = (t: string) => ({ type: 'paragraph', content: [{ type: 'text', text: t }] })
const DOC = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'The Crossing' }] },
    para('Mara saw teh ferry long before she heard it, a low shape sliding out of the fog.'),
    para('She counted the lamps along its rail and waited, her bag at her feet.'),
    { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'The Island' }] },
    para('The harbour smelled of tar and rain.'),
  ],
}
const CONNECTION = { id: 'conn-e2e', provider: 'openai', label: 'OpenAI', auth: 'api_key', defaultModel: 'gpt-6.2-sol' }
const EXPLANATION =
  '“Teh” is a common typo for **the**: two letters swapped while typing fast. The rest of the sentence reads well. I listed the fix so you can apply it yourself.'

const panel = (page: Page) => page.getByTestId('tutor-panel')
const ctl = (page: Page, id: string) => panel(page).locator(`[data-control-id="${id}"]`)
const composer = (page: Page) => ctl(page, 'tutor.composer')
const underline = (page: Page) => editor(page).locator('.spell-error')
const focusedId = (page: Page) => page.evaluate(() => document.activeElement?.closest('[data-control-id]')?.getAttribute('data-control-id') ?? null)
const aiRequests = (page: Page) => page.evaluate(() => window.__nvE2E.aiRequests())

async function open(page: Page, width = 1400, height = 900) {
  await page.setViewportSize({ width, height })
  await page.addInitScript((c) => {
    ;(window as unknown as { __nvE2EConfig?: Record<string, unknown> }).__nvE2EConfig = { tutorConnections: [c] }
  }, CONNECTION)
  await launch(page)
  await seedProject(page, FOLDER, TITLE, DOC)
  await openRecent(page, FOLDER)
  await expect(saveStatus(page)).toHaveText(`${TITLE}: All changes saved`)
  await waitForLayout(page)
  await expect(underline(page)).toHaveText(['teh'])
}

/** The caret in the first paragraph (page 1), then Ctrl/Cmd+Shift+Y. */
async function openPanel(page: Page) {
  await clickBlockStart(page, editor(page).locator(':scope > p').first())
  await page.keyboard.press('ControlOrMeta+Shift+Y')
  await expect(panel(page)).toBeVisible()
  await expect(composer(page)).toBeFocused()
}

async function attach(page: Page, item: RegExp) {
  await ctl(page, 'tutor.attach').click()
  await page.getByRole('menuitem', { name: item }).click()
  await expect(composer(page)).toBeFocused()
}

/**
 * Ask about the flagged word: the fake provider explains and lists the correction in one step (p2 is the
 * first paragraph: the title is p1), then closes with a line after the tool result.
 */
async function askAboutTypo(page: Page) {
  await attach(page, /Current Page/)
  await expect(panel(page).getByTestId('tutor-chip')).toHaveCount(1)
  await expect(panel(page).getByTestId('tutor-chip')).toContainText('Page 1')
  await composer(page).fill('Is the underlined word wrong?')
  expect(await aiRequests(page), 'nothing is sent before ➤').toBe(0)
  await page.evaluate(
    ([explanation]) =>
      window.__nvE2E.tutorQueue([
        {
          text: explanation,
          tools: [
            {
              name: 'list_corrections',
              input: { items: [{ paragraph: 'p2', kind: 'spelling', original: 'teh', suggestion: 'the', explanation: 'Two letters swapped: the word is “the”.' }] },
            },
          ],
        },
        { text: 'Apply it with **Fix**, or leave the word as it is if you meant it.' },
      ]),
    [EXPLANATION] as const,
  )
  await page.keyboard.press('Enter')
  const reply = panel(page).getByTestId('tutor-reply').last()
  await expect(reply).toContainText('Apply it with Fix', { timeout: 15_000 })
  await expect(reply).toContainText('common typo for the')
  await expect(reply).not.toHaveAttribute('data-streaming', 'true')
  return reply
}

test.beforeEach(async ({ page }, testInfo) => {
  await seedProjectNavigation(page, testInfo)
})

test('open with Ctrl/Cmd+Shift+Y, attach the page, ask about a flagged error, see the explanation and the correction list, Fix it', async ({ page }) => {
  await open(page)
  await openPanel(page)
  await expect(panel(page).getByTestId('tutor-greeting')).toContainText("Hi, I'm ready to help with all your writing needs.")
  await expect(panel(page).getByText(/Using:/)).toHaveText(/Using: OpenAI · gpt-6\.2-sol/)
  expect(await aiRequests(page)).toBe(0)
  const reply = await askAboutTypo(page)
  expect(await aiRequests(page)).toBe(2)
  const item = reply.locator('[data-correction-id]')
  await expect(item).toHaveCount(1)
  await expect(item.locator('[data-control-id="tutor.correction.jump"]')).toHaveText('Ch 1 ¶1, line 1')
  await expect(item).toContainText('teh')
  await expect(item).toContainText('the')
  await item.locator('[data-control-id="tutor.correction.fix"]').click()
  await expect(item).toHaveAttribute('data-state', 'applied')
  await expect(item).toContainText('Fixed')
  await expect(editor(page).locator(':scope > p').first()).toHaveText('Mara saw the ferry long before she heard it, a low shape sliding out of the fog.')
  // Undo in the manuscript takes it back (one step).
  await editor(page).focus()
  await page.keyboard.press('ControlOrMeta+z')
  await expect(editor(page).locator(':scope > p').first()).toContainText('saw teh ferry')
  // Shortcut again closes the panel.
  await page.keyboard.press('ControlOrMeta+Shift+Y')
  await expect(panel(page)).toHaveCount(0)
})

test('below 768 px the panel floats over the pages; Escape hides it', async ({ page }) => {
  await open(page, 720, 800)
  await openPanel(page)
  await expect(panel(page)).toHaveAttribute('data-overlay', 'true')
  const box = (await panel(page).boundingBox())!
  expect(box.x + box.width).toBeLessThanOrEqual(720 + 1)
  expect(box.width).toBeLessThan(720)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(720)
  await page.keyboard.press('Escape')
  await expect(panel(page)).toHaveCount(0)
  await expect(editor(page)).toBeFocused()
})

test('tooltips and keyboard: every panel control has a wired tooltip and is reached by Tab with a focus ring', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.endsWith('-scroll'), 'the audits do not depend on page navigation')
  await open(page)
  await openPanel(page)
  const audit = async (where: string) => expect(await page.evaluate(() => window.__nvE2E.auditTooltips()), `tooltips: ${where}`).toEqual([])
  await audit('greeting')
  await ctl(page, 'tutor.attach').click()
  await expect(page.getByRole('menu')).toBeVisible()
  await audit('+ menu')
  await page.keyboard.press('Escape')
  await askAboutTypo(page)
  await audit('a reply with a correction list')

  // Tab from the composer through the whole panel (wrapping around the app is fine): every enabled
  // control is reached, each showing a focus ring.
  const expected = await page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>('[data-testid="tutor-panel"] [data-control-id]'))
      .filter((e) => !(e as HTMLButtonElement).disabled && e.checkVisibility?.() !== false)
      .map((e) => e.getAttribute('data-control-id')!),
  )
  await composer(page).focus()
  const seen = new Set<string>()
  for (let i = 0; i < 40 && seen.size < new Set(expected).size; i++) {
    await pressTab(page)
    const info = await page.evaluate(() => {
      const a = document.activeElement as HTMLElement | null
      const id = a?.getAttribute('data-control-id') ?? null
      // The composer shows its focus on its box (a ring around the chips, the text and the buttons).
      const ring = !a ? 'none' : id === 'tutor.composer' ? getComputedStyle(a.closest('[data-testid="tutor-composer"] > div')!).boxShadow : getComputedStyle(a).outlineStyle
      return { inside: !!a?.closest('[data-testid="tutor-panel"]'), id, ring }
    })
    if (!info.inside || !info.id) continue
    seen.add(info.id)
    expect(info.ring, `${info.id} shows focus`).not.toBe('none')
  }
  expect([...new Set(expected)].filter((id) => !seen.has(id)), 'not reached by Tab').toEqual([])

  // The + menu by keyboard: Enter opens it, arrows move, Enter attaches.
  await composer(page).focus()
  await pressTab(page)
  expect(await focusedId(page)).toBe('tutor.attach')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('menuitem', { name: /Current Page/ })).toBeFocused()
  await page.keyboard.press('End')
  await expect(page.getByRole('menuitem', { name: /Whole Manuscript/ })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(panel(page).getByTestId('tutor-chip')).toContainText('Whole manuscript')
  await expect(composer(page)).toBeFocused()
  // Escape gives the manuscript the focus (docked).
  await page.keyboard.press('Escape')
  await expect(editor(page)).toBeFocused()
})

/**
 * Mark every text-bearing element and every icon-only control inside `root` (visible ones) for the
 * measurer (as e2e/phase4-audits.spec.ts): text 4.5:1 on its composited background, an icon 3:1.
 */
async function mark(page: Page, name: string, root: string): Promise<number> {
  return page.evaluate(
    ([n, sel]) => {
      document.querySelectorAll(`[data-nv-probe="${n}"]`).forEach((e) => e.removeAttribute('data-nv-probe'))
      let k = 0
      for (const r of Array.from(document.querySelectorAll(sel))) {
        for (const el of [r, ...Array.from(r.querySelectorAll('*'))]) {
          if (!el.checkVisibility?.() || el.closest('svg')) continue
          // Disabled controls are exempt (WCAG 1.4.3); the composer's placeholder is measured as text.
          if (el.closest('[aria-disabled="true"], :disabled')) continue
          const own = Array.from(el.childNodes).some((c) => c.nodeType === 3 && c.textContent!.trim())
          const icon = el.matches('[data-control-id]') && !el.textContent!.trim() && !!el.querySelector('svg')
          if (own || icon) {
            el.setAttribute('data-nv-probe', n)
            k++
          }
        }
      }
      return k
    },
    [name, root] as const,
  )
}
const probe = (name: string, min: number): Probe => ({ what: name, sel: `[data-nv-probe="${name}"]`, kind: 'auto', all: true, min })

test('WCAG AA contrast of the panel in OS light and dark (greeting, a reply with corrections, the + menu)', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.endsWith('-scroll'), 'colours do not depend on page navigation')
  test.setTimeout(120_000)
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
  await open(page)
  await openPanel(page)
  const failures: string[] = []
  let checked = 0
  const take = async (where: string, name: string, root: string, min: number) => {
    const n = await mark(page, name, root)
    if (n < min) failures.push(`${where} ${name}: ${n} of at least ${min} elements found`)
    const got = await settled(page, [probe(name, min)])
    for (const m of got.missing) failures.push(`${where} ${m}`)
    for (const e of got.errors) failures.push(`${where} ${e}`)
    for (const x of got.samples) {
      checked++
      if (x.ratio < x.min) failures.push(`${where} ${x.what} "${x.probe}": ${x.ratio}:1 < ${x.min}:1 (fg ${x.fg} on ${x.bg})`)
    }
  }
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' })
    await expect(page.locator('html')).toHaveAttribute('data-theme', scheme)
    await page.mouse.move(0, 0)
    if (scheme === 'light') {
      await take(scheme, 'greeting', '[data-testid="tutor-panel"]', 8)
      await askAboutTypo(page)
      // A question typed: ➤ enabled (its icon on the accent fill is measured too).
      await composer(page).fill('And the next paragraph?')
    }
    await page.mouse.move(0, 0)
    await take(scheme, 'reply with corrections', '[data-testid="tutor-panel"]', 14)
    await ctl(page, 'tutor.attach').click()
    await expect(page.getByRole('menu')).toBeVisible()
    await take(scheme, '+ menu', '[role="menu"]', 4)
    await page.keyboard.press('Escape')
  }
  console.info(`[tutor contrast] ${checked} samples checked`)
  expect(failures).toEqual([])
})

const SHOTS = join(process.cwd(), '.superpowers', 'sdd', '2026-11-19-ai-tutor', 'screenshots')

test('screenshots of the panel for the report: light and dark, the greeting and a reply with corrections and a chip', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', 'one set of screenshots (chromium, Book mode)')
  mkdirSync(SHOTS, { recursive: true })
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
  await open(page, 1440, 900)
  await openPanel(page)
  await page.mouse.move(0, 0)
  await page.screenshot({ path: join(SHOTS, 'tutor-light-greeting.png') })
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.mouse.move(0, 0)
  await page.screenshot({ path: join(SHOTS, 'tutor-dark-greeting.png') })
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
  await askAboutTypo(page)
  // A chip ready for the next question.
  // The chapter list by keyboard (a submenu): ArrowRight opens it on its first chapter, Enter attaches.
  await ctl(page, 'tutor.attach').click()
  await page.getByRole('menuitem', { name: /Current Chapter/ }).focus()
  await page.keyboard.press('ArrowRight')
  await expect(page.getByRole('menuitem', { name: /The Crossing/ })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(panel(page).getByTestId('tutor-chip')).toContainText('Chapter 1: The Crossing')
  await composer(page).fill('Is the pacing of this chapter right?')
  await page.mouse.move(0, 0)
  await page.screenshot({ path: join(SHOTS, 'tutor-light-corrections.png') })
  await panel(page).screenshot({ path: join(SHOTS, 'tutor-light-corrections-panel.png') })
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.mouse.move(0, 0)
  await page.screenshot({ path: join(SHOTS, 'tutor-dark-corrections.png') })
  await panel(page).screenshot({ path: join(SHOTS, 'tutor-dark-corrections-panel.png') })
})
