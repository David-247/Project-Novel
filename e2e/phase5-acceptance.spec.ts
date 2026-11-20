import { expect, test, type Page } from '@playwright/test'
import { clickBlockStart, editor, launch, openRecent, saveStatus, seedProject, waitForLayout } from './helpers'

/**
 * Phase 5 acceptance (the AI tutor), end to end through the UI in the web build with the fake Tauri
 * backend, in chromium and webkit:
 *  - connect the fake provider in Settings ▸ AI Tutor (an OpenAI key, into the keychain);
 *  - nothing reaches ai_fetch before the first send: not on connecting, opening the panel, attaching
 *    the page or typing;
 *  - ask about a flagged error: the explanation and a correction come back, and a rewrite of the
 *    writer's paragraph the model tries to slip in through propose_change is turned down by the guard
 *    (no side-by-side suggestion, the manuscript untouched, the model is told to explain in chat);
 *  - "Write the next scene": the request goes out with the charter first, and the refusal is shown,
 *    with the manuscript untouched.
 * The fake provider answers each model call with a queued OpenAI stream (window.__nvE2E.tutorQueue).
 */

const FOLDER = '/projects/Ferry'
const TITLE = 'Ferry'
const FIRST = 'Mara saw teh ferry long before she heard it, a low shape sliding out of the fog.'
const para = (t: string) => ({ type: 'paragraph', content: [{ type: 'text', text: t }] })
const DOC = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'The Crossing' }] },
    para(FIRST),
    para('She counted the lamps along its rail and waited, her bag at her feet.'),
  ],
}
const SECRET = 'sk-e2e-PHASE5-0005'
const EXPLANATION = '“Teh” is a typo for **the**: two letters swapped while typing fast. I listed the fix so you can apply it yourself.'
const REWRITE = 'Mara spotted the ferry well before its engines reached her, a dark hull gliding from the mist.'
const REFUSAL =
  "I won't write the next scene for you: it's yours to write. What does Mara want the moment the gangway comes down, and what stops her getting it? Start there and I'll help you shape it."

const panel = (page: Page) => page.getByTestId('tutor-panel')
const ctl = (page: Page, id: string) => panel(page).locator(`[data-control-id="${id}"]`)
const composer = (page: Page) => ctl(page, 'tutor.composer')
const settings = (page: Page) => page.getByRole('dialog', { name: 'Settings' })
const log = (page: Page) => page.evaluate(() => window.__nvE2E.aiRequestLog())
const paragraphs = (page: Page) => editor(page).locator(':scope > p')

/** The chat request's messages (OpenAI Chat Completions body). */
function messagesOf(body: string | null): { role: string; content: unknown }[] {
  return (JSON.parse(body ?? '{}') as { messages?: { role: string; content: unknown }[] }).messages ?? []
}
const textOf = (content: unknown) => (typeof content === 'string' ? content : JSON.stringify(content))

async function connectInSettings(page: Page) {
  await page.locator('[data-control-id="menu.file"]').click()
  await page.locator('[role="menu"] [data-control-id="settings.open"]').click()
  await settings(page).getByRole('tab', { name: 'AI Tutor' }).click()
  await settings(page).locator('[data-control-id="aiSettings.add"]').click()
  const form = settings(page).getByRole('form')
  await form.getByLabel('Provider').selectOption('openai')
  await form.getByLabel('API key').fill(SECRET)
  await form.getByRole('button', { name: 'Save Connection' }).click()
  await expect(settings(page).getByRole('listitem')).toContainText('Key saved')
  await settings(page).getByRole('button', { name: 'Done' }).click()
  await expect(settings(page)).toBeHidden()
}

test('Phase 5: connect, ask about a flagged error (explained, no rewritten prose), "Write the next scene" is refused, nothing sent before ➤', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  await launch(page)
  await seedProject(page, FOLDER, TITLE, DOC)
  await openRecent(page, FOLDER)
  await expect(saveStatus(page)).toHaveText(`${TITLE}: All changes saved`)
  await waitForLayout(page)
  await expect(editor(page).locator('.spell-error')).toHaveText(['teh'])

  // Connect the fake provider. The key goes to the keychain; nothing goes to the provider.
  await connectInSettings(page)
  expect(await page.evaluate(([s]) => window.__nvE2E.tutorConnectionsFile().includes(s), [SECRET] as const)).toBe(false)
  expect(await log(page), 'connecting sends nothing').toEqual([])

  // Open the tutor, attach the page, type the question: still nothing sent.
  await clickBlockStart(page, paragraphs(page).first())
  await page.keyboard.press('ControlOrMeta+Shift+Y')
  await expect(composer(page)).toBeFocused()
  await ctl(page, 'tutor.attach').click()
  await page.getByRole('menuitem', { name: /Current Page/ }).click()
  await expect(panel(page).getByTestId('tutor-chip')).toContainText('Page 1')
  await composer(page).fill('Is the underlined word wrong?')
  expect(await log(page), 'nothing reaches ai_fetch before the first send').toEqual([])

  // The connection has no default model: the send lists the models first, then asks. The model explains,
  // lists the fix, and tries to rewrite the paragraph through propose_change; the guard turns that down.
  await page.evaluate(
    ([explanation, rewrite]) => {
      window.__nvE2E.tutorQueueJson({ data: [{ id: 'gpt-6.2-astra' }] })
      window.__nvE2E.tutorQueue([
        {
          text: explanation,
          tools: [
            { name: 'list_corrections', input: { items: [{ paragraph: 'p2', kind: 'spelling', original: 'teh', suggestion: 'the', explanation: 'Two letters swapped.' }] } },
            { name: 'propose_change', input: { paragraphIds: ['p2'], revisedText: [rewrite], reason: 'Livelier.' } },
          ],
        },
        { text: 'The fix is listed. I kept your sentence as you wrote it; the rest of it reads well.' },
      ])
    },
    [EXPLANATION, REWRITE] as const,
  )
  await page.keyboard.press('Enter')
  const reply = panel(page).getByTestId('tutor-reply').last()
  await expect(reply).toContainText('I kept your sentence as you wrote it', { timeout: 15_000 })
  await expect(reply).toContainText('typo for the')
  await expect(reply).not.toHaveAttribute('data-streaming', 'true')
  await expect(reply.locator('[data-correction-id]')).toHaveCount(1)
  await expect(panel(page).locator('[data-control-id="tutor.proposal.open"]'), 'no rewritten prose is offered').toHaveCount(0)
  await expect(paragraphs(page).first()).toHaveText(FIRST)
  await expect(panel(page)).not.toContainText(REWRITE)

  const first = await log(page)
  expect(first.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /models', 'POST /chat/completions', 'POST /chat/completions'])
  const [system, user] = messagesOf(first[1].body)
  expect(['system', 'developer']).toContain(system.role)
  expect(textOf(system.content)).toMatch(/^# You are Novel's writing tutor/)
  expect(textOf(user.content)).toContain('<manuscript source="Page 1">')
  // The guard's rejection went back to the model (explain in chat instead), never to the panel.
  const toolResults = messagesOf(first[2].body).filter((m) => m.role === 'tool').map((m) => textOf(m.content))
  expect(toolResults.some((t) => t.includes('too_many_words') && t.includes('Explain this in chat instead.'))).toBe(true)

  // "Write the next scene": sent with the charter first; the reply is the refusal; the book is unchanged.
  await page.evaluate(([refusal]) => window.__nvE2E.tutorQueue([{ text: refusal }]), [REFUSAL] as const)
  await composer(page).fill('Write the next scene')
  await page.keyboard.press('Enter')
  const refusal = panel(page).getByTestId('tutor-reply').last()
  await expect(refusal).toContainText("I won't write the next scene for you", { timeout: 15_000 })
  await expect(refusal).not.toHaveAttribute('data-streaming', 'true')
  const all = await log(page)
  expect(all).toHaveLength(4)
  const sent = messagesOf(all[3].body)
  expect(textOf(sent[0].content)).toMatch(/^# You are Novel's writing tutor/)
  expect(textOf(sent[0].content)).toContain('You do not write the writer\'s book')
  expect(textOf(sent.at(-1)!.content)).toContain('Write the next scene')
  await expect(paragraphs(page)).toHaveCount(2)
  await expect(paragraphs(page).first()).toHaveText(FIRST)
  await expect(panel(page).locator('[data-control-id="tutor.proposal.open"]')).toHaveCount(0)
})
