import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { settled, type Probe } from './contrast'
import { launch, pressTab } from './helpers'

/**
 * Settings ▸ AI Tutor (Phase 5 T10) in the web build with the fake Tauri backend:
 *  - "Connect a Provider…" in the tutor lands on the page (openSettings('ai-tutor'));
 *  - adding a connection with a key: the key reaches the keychain only, never ai-connections.json or
 *    preferences.json, and the field is empty when the form opens again ("Key saved");
 *  - plain http to another computer needs the confirmation;
 *  - Sign in with OpenRouter: Rust is asked (the fake records it), the result event adds the connection;
 *  - Continue with ChatGPT (T12): the ban warning once before the first sign-in, then as OpenRouter; Manage
 *    Usage and Sign In Again go to Rust by provider and connection id;
 *  - audits: tooltips, keyboard reachability, WCAG AA contrast in OS light and dark;
 *  - screenshots for the report (chromium only).
 */

const SECRET = 'sk-e2e-TOP-SECRET-0042'
const dialog = (page: Page) => page.getByRole('dialog', { name: 'Settings' })
const ctl = (page: Page, id: string) => dialog(page).locator(`[data-control-id="${id}"]`)
const form = (page: Page) => dialog(page).getByRole('form')

/** File > Settings…, then the AI Tutor page in the page list. */
async function openAiPage(page: Page) {
  await page.locator('[data-control-id="menu.file"]').click()
  await page.locator('[role="menu"] [data-control-id="settings.open"]').click()
  await expect(dialog(page)).toBeVisible()
  await dialog(page).getByRole('tab', { name: 'AI Tutor' }).click()
  await expect(dialog(page).getByRole('tab', { name: 'AI Tutor' })).toHaveAttribute('aria-selected', 'true')
}

test('"Connect a Provider…" in the tutor opens Settings on the AI Tutor page', async ({ page }) => {
  await launch(page)
  await page.keyboard.press('ControlOrMeta+Shift+Y')
  const panel = page.getByTestId('tutor-panel')
  await expect(panel).toBeVisible()
  await panel.locator('[data-control-id="tutor.model"]').click()
  await page.getByRole('menuitem', { name: 'Connect a Provider…' }).click()
  await expect(dialog(page).getByRole('tab', { name: 'AI Tutor' })).toHaveAttribute('aria-selected', 'true')
  await expect(dialog(page)).toContainText("Claude subscriptions can't be used by other apps (Anthropic's rule). Use an API key or OpenRouter.")
  await expect(dialog(page)).toContainText('Chats are saved on this computer with the text you attached.')
})

test('a key goes to the keychain only, and the field is empty when reopened', async ({ page }) => {
  await launch(page)
  await openAiPage(page)
  await ctl(page, 'aiSettings.add').click()
  await form(page).getByLabel('Provider').selectOption('openai')
  await form(page).getByLabel('API key').fill(SECRET)
  await form(page).getByRole('button', { name: 'Save Connection' }).click()
  await expect(form(page)).toHaveCount(0)
  await expect(dialog(page).getByRole('listitem')).toContainText('Key saved')

  const file = await page.evaluate(() => window.__nvE2E.tutorConnectionsFile())
  const [id] = (JSON.parse(file) as { id: string }[]).map((c) => c.id)
  expect(file).not.toContain(SECRET)
  expect(await page.evaluate(([i, s]) => window.__nvE2E.tutorSecretIs(i, s), [id, SECRET] as const)).toBe(true)
  await dialog(page).getByRole('button', { name: 'Done' }).click()
  await expect(dialog(page)).toBeHidden()
  await expect.poll(() => page.evaluate(() => window.__nvE2E.preferencesFile())).toContain('tutorActiveConnection')
  expect((await page.evaluate(() => window.__nvE2E.preferencesFile())) ?? '').not.toContain(SECRET)
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(SECRET)

  await openAiPage(page)
  await dialog(page).getByRole('button', { name: 'Edit OpenAI' }).click()
  await expect(form(page).getByLabel('API key')).toHaveValue('')
  await expect(form(page).getByTestId('ai-key-saved')).toHaveText('Key saved')
  expect(await page.evaluate(() => document.body.innerHTML)).not.toContain(SECRET)
})

test('plain http to another computer asks first', async ({ page }) => {
  await launch(page)
  await openAiPage(page)
  await ctl(page, 'aiSettings.add').click()
  await form(page).getByLabel('Provider').selectOption('custom')
  await form(page).getByLabel('Server address').fill('http://192.168.1.20:8080/v1')
  await form(page).getByRole('button', { name: 'Save Connection' }).click()
  const ask = page.getByRole('dialog', { name: 'Send your text unencrypted?' })
  await expect(ask).toContainText('192.168.1.20:8080')
  await ask.getByRole('button', { name: 'Cancel' }).click()
  await expect(ask).toBeHidden()
  expect(await page.evaluate(() => window.__nvE2E.tutorConnectionsFile())).toBe('[]')
  await form(page).getByRole('button', { name: 'Save Connection' }).click()
  await page.getByRole('dialog', { name: 'Send your text unencrypted?' }).getByRole('button', { name: 'Use Unencrypted Address' }).click()
  await expect(form(page)).toHaveCount(0)
  expect(JSON.parse(await page.evaluate(() => window.__nvE2E.tutorConnectionsFile()))).toEqual([
    expect.objectContaining({ provider: 'custom', baseUrl: 'http://192.168.1.20:8080/v1', insecureHttpAccepted: true }),
  ])
})

test('Sign in with OpenRouter: Rust opens the browser; its result adds the connection as the default', async ({ page }) => {
  await launch(page)
  await openAiPage(page)
  await ctl(page, 'aiSettings.signIn').click()
  await expect.poll(() => page.evaluate(() => window.__nvE2E.oauthStarts())).toEqual(['openrouter'])
  await expect(dialog(page).getByTestId('ai-sign-in-status')).toContainText('Finish signing in to OpenRouter in your browser')
  const id = await page.evaluate(() => window.__nvE2E.completeOAuth('sk-or-v1-e2e-secret'))
  await page.evaluate((i) => window.__nvE2E.emit('ai-oauth-result', { ok: true, connectionId: i }), id)
  await expect(dialog(page).getByTestId('ai-sign-in-status')).toContainText('Signed in. “OpenRouter” is ready to use.')
  await expect(dialog(page).getByRole('listitem')).toContainText('(Default)')
  await expect(dialog(page).getByRole('listitem')).toContainText('Signed in')
  expect(await page.evaluate(() => document.body.innerHTML)).not.toContain('sk-or-v1-e2e-secret')
})

test('Continue with ChatGPT: the ban warning once, then Rust signs in; Manage Usage and Sign In Again', async ({ page }) => {
  await launch(page)
  await openAiPage(page)
  await ctl(page, 'aiSettings.signIn.chatgpt').click()
  const warning = page.getByRole('dialog', { name: 'Before you sign in with your ChatGPT plan' })
  await expect(warning).toContainText("governed by the provider's terms of use")
  expect(await page.evaluate(() => window.__nvE2E.auditTooltips())).toEqual([])
  await warning.getByRole('button', { name: 'Continue to Sign In' }).click()
  await expect(warning).toBeHidden()
  await expect.poll(() => page.evaluate(() => window.__nvE2E.oauthStarts())).toEqual(['chatgpt'])
  await expect(dialog(page).getByTestId('ai-sign-in-status')).toContainText('Finish signing in to ChatGPT in your browser')
  await expect.poll(() => page.evaluate(() => window.__nvE2E.preferencesFile())).toContain('"tutorPlanWarningSeen": true')
  const record = '{"v":1,"accessToken":"e2e-ACCESS-secret","refreshToken":"e2e-REFRESH-secret"}'
  const id = await page.evaluate((r) => window.__nvE2E.completeOAuth(r, 'chatgpt', 'ChatGPT (writer@example.com)'), record)
  await page.evaluate((i) => window.__nvE2E.emit('ai-oauth-result', { ok: true, connectionId: i }), id)
  await expect(dialog(page).getByTestId('ai-sign-in-status')).toContainText('the tutor now uses your ChatGPT plan')
  const row = dialog(page).getByRole('listitem')
  await expect(row).toContainText('Signed in · Using your ChatGPT plan')
  await expect(row).toContainText('(Default)')
  for (const s of ['e2e-ACCESS-secret', 'e2e-REFRESH-secret']) {
    expect(await page.evaluate(() => document.body.innerHTML)).not.toContain(s)
    expect(await page.evaluate(() => window.__nvE2E.tutorConnectionsFile())).not.toContain(s)
  }
  await row.getByRole('button', { name: 'Manage Usage ChatGPT (writer@example.com)' }).click()
  await expect.poll(() => page.evaluate(() => window.__nvE2E.usagePages())).toEqual(['chatgpt'])
  // The warning was read once: the next sign-in (a renewal here) goes straight to the browser.
  await row.getByRole('button', { name: 'Sign In Again ChatGPT (writer@example.com)' }).click()
  await expect.poll(() => page.evaluate(() => window.__nvE2E.oauthStarts())).toEqual(['chatgpt', 'chatgpt'])
  await expect(page.getByRole('dialog', { name: 'Before you sign in with your ChatGPT plan' })).toHaveCount(0)
  expect(await page.evaluate(() => window.__nvE2E.auditTooltips())).toEqual([])
})

test('every control has a tooltip and is reachable with Tab', async ({ page }) => {
  await page.addInitScript(() => {
    window.__nvE2EConfig = { tutorConnections: [{ id: 'c1', provider: 'ollama', label: 'Ollama', auth: 'none', baseUrl: 'http://localhost:11434/v1' }] }
  })
  await launch(page)
  await openAiPage(page)
  expect(await page.evaluate(() => window.__nvE2E.auditTooltips())).toEqual([])
  await dialog(page).getByRole('button', { name: 'Edit Ollama' }).click()
  expect(await page.evaluate(() => window.__nvE2E.auditTooltips())).toEqual([])
  // Tab from the page list visits every enabled control of the page once, then the footer.
  await dialog(page).getByRole('tab', { name: 'AI Tutor' }).focus()
  const want = [
    'aiSettings.setDefault',
    'aiSettings.edit',
    'aiSettings.remove',
    'aiSettings.signIn.chatgpt',
    'aiSettings.signIn',
    'aiSettings.label',
    'aiSettings.baseUrl',
    'aiSettings.defaultModel',
    'aiSettings.cancel',
    'aiSettings.test',
    'aiSettings.save',
    'aiSettings.clearAll',
    'settings.done',
  ]
  const seen: string[] = []
  for (let i = 0; i < 20 && seen.at(-1) !== 'settings.done'; i++) {
    await pressTab(page)
    seen.push((await page.evaluate(() => document.activeElement?.getAttribute('data-control-id') ?? '')) as string)
  }
  // Set as Default is absent: the only connection is the default. Clear This Project's Chats is disabled (no project).
  expect(seen).toEqual(want.filter((w) => w !== 'aiSettings.setDefault'))
})

/** Mark visible text and icon-only controls inside `root` (as e2e/tutor.spec.ts). */
async function mark(page: Page, name: string, root: string): Promise<number> {
  return page.evaluate(
    ([n, sel]) => {
      document.querySelectorAll(`[data-nv-probe="${n}"]`).forEach((e) => e.removeAttribute('data-nv-probe'))
      let k = 0
      for (const r of Array.from(document.querySelectorAll(sel))) {
        for (const el of [r, ...Array.from(r.querySelectorAll('*'))]) {
          if (!el.checkVisibility?.() || el.closest('svg')) continue
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

async function signedInWithForm(page: Page) {
  await page.addInitScript(() => {
    window.__nvE2EConfig = {
      tutorConnections: [
        { id: 'c1', provider: 'anthropic', label: 'Anthropic', auth: 'api_key', defaultModel: 'claude-sonnet-5-5' },
        { id: 'c2', provider: 'ollama', label: 'Ollama on this computer', auth: 'none', baseUrl: 'http://localhost:11434/v1' },
        { id: 'c3', provider: 'chatgpt', label: 'ChatGPT (writer@example.com)', auth: 'oauth' },
      ],
    }
  })
  await launch(page)
  await openAiPage(page)
  await dialog(page).getByRole('button', { name: 'Edit Anthropic' }).click()
  await form(page).getByLabel('API key').fill('typed')
  await form(page).getByLabel('API key').fill('')
}

test('WCAG AA contrast of the page in OS light and dark', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.endsWith('-scroll'), 'colours do not depend on page navigation')
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
  await signedInWithForm(page)
  const failures: string[] = []
  let checked = 0
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' })
    await expect(page.locator('html')).toHaveAttribute('data-theme', scheme)
    await page.mouse.move(0, 0)
    const n = await mark(page, 'ai-settings', '[role="dialog"]')
    if (n < 20) failures.push(`${scheme}: only ${n} elements found`)
    const probe: Probe = { what: 'ai-settings', sel: '[data-nv-probe="ai-settings"]', kind: 'auto', all: true, min: 20 }
    const got = await settled(page, [probe])
    for (const m of [...got.missing, ...got.errors]) failures.push(`${scheme} ${m}`)
    for (const x of got.samples) {
      checked++
      if (x.ratio < x.min) failures.push(`${scheme} ${x.what}: ${x.ratio}:1 < ${x.min}:1 (fg ${x.fg} on ${x.bg})`)
    }
  }
  console.info(`[ai settings contrast] ${checked} samples checked`)
  expect(failures).toEqual([])
})

test('WCAG AA contrast of the ban warning in OS light and dark', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.endsWith('-scroll'), 'colours do not depend on page navigation')
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
  await launch(page)
  await openAiPage(page)
  await ctl(page, 'aiSettings.signIn.chatgpt').click()
  const warning = page.getByRole('dialog', { name: 'Before you sign in with your ChatGPT plan' })
  await expect(warning).toBeVisible()
  const failures: string[] = []
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' })
    await expect(page.locator('html')).toHaveAttribute('data-theme', scheme)
    await page.mouse.move(0, 0)
    const n = await mark(page, 'plan-warning', '[role="dialog"]:has([data-testid="ai-plan-warning"])')
    if (n < 5) failures.push(`${scheme}: only ${n} elements found`)
    const got = await settled(page, [{ what: 'plan-warning', sel: '[data-nv-probe="plan-warning"]', kind: 'auto', all: true, min: 5 }])
    for (const m of [...got.missing, ...got.errors]) failures.push(`${scheme} ${m}`)
    for (const x of got.samples) if (x.ratio < x.min) failures.push(`${scheme} ${x.what}: ${x.ratio}:1 < ${x.min}:1 (fg ${x.fg} on ${x.bg})`)
  }
  expect(failures).toEqual([])
})

const SHOTS = join(process.cwd(), '.superpowers', 'sdd', '2026-11-19-ai-tutor', 'screenshots')

test('screenshots of the page for the report: light and dark', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', 'one set of screenshots (chromium)')
  mkdirSync(SHOTS, { recursive: true })
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
  await signedInWithForm(page)
  await page.mouse.move(0, 0)
  await dialog(page).screenshot({ path: join(SHOTS, 'task-10-light-form.png') })
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.mouse.move(0, 0)
  await dialog(page).screenshot({ path: join(SHOTS, 'task-10-dark-form.png') })
  await form(page).getByRole('button', { name: 'Cancel' }).click()
  await page.mouse.move(0, 0)
  await dialog(page).screenshot({ path: join(SHOTS, 'task-10-dark-list.png') })
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
  await page.mouse.move(0, 0)
  await dialog(page).screenshot({ path: join(SHOTS, 'task-10-light-list.png') })
  await page.setViewportSize({ width: 420, height: 800 })
  await page.mouse.move(0, 0)
  await dialog(page).screenshot({ path: join(SHOTS, 'task-10-light-narrow.png') })
})

test('screenshots of the ban warning for the report (T12)', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', 'one set of screenshots (chromium)')
  mkdirSync(SHOTS, { recursive: true })
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
  await launch(page)
  await openAiPage(page)
  await ctl(page, 'aiSettings.signIn.chatgpt').click()
  const warning = page.getByRole('dialog', { name: 'Before you sign in with your ChatGPT plan' })
  await expect(warning).toBeVisible()
  await page.mouse.move(0, 0)
  await warning.screenshot({ path: join(SHOTS, 'task-12-light-ban-warning.png') })
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.mouse.move(0, 0)
  await warning.screenshot({ path: join(SHOTS, 'task-12-dark-ban-warning.png') })
})
