import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useStore } from '@/shared/store'
import { TooltipProvider } from '@/shared/ui'
import { auditTooltipCoverage, formatCoverageProblems, getTooltipCopy } from '@/features/tooltips'
import { backend, core } from '@/test-utils/fake-tauri'
import { sseResponse, toBase64Text, type FakeAiEvent } from '@/test-utils/fake-ai'

vi.mock('@tauri-apps/api/core', async () => (await import('@/test-utils/fake-tauri')).coreModule)
// Tauri events: the test fires `ai-oauth-result` itself (Rust would, when the browser comes back).
const events = vi.hoisted(() => ({ handlers: new Map<string, Set<(e: { payload: unknown }) => void>>() }))
vi.mock('@tauri-apps/api/event', () => ({
  listen: async (name: string, cb: (e: { payload: unknown }) => void) => {
    const set = events.handlers.get(name) ?? new Set()
    set.add(cb)
    events.handlers.set(name, set)
    return () => set.delete(cb)
  },
}))
const emit = (name: string, payload: unknown) => events.handlers.get(name)?.forEach((cb) => cb({ payload }))

import { flushPreferences, loadPreferences, startPreferencesWriter } from '@/features/settings'
import { loadTutorConnections } from '../connections/store'
import { __resetTutorChatForTests } from '../panel/chat'
import { AiTutorSettings } from './AiTutorSettings'
import { HISTORY_NOTE, SUBSCRIPTION_NOTE } from './controls'
import { __resetSignInForTests, listenForSignIn } from './sign-in'

const SECRET = 'sk-TOP-SECRET-key-123'

let stopWriter: () => void = () => {}
let stopSignIn: () => void = () => {}

beforeEach(async () => {
  backend.reset()
  __resetSignInForTests()
  __resetTutorChatForTests()
  useStore.getState().tutorConnectionsActions.setConnections([], null)
  useStore.setState((s) => ({ tutorConnections: { ...s.tutorConnections, loaded: false } }))
  stopWriter = startPreferencesWriter()
  await loadPreferences()
  stopSignIn = listenForSignIn()
})

afterEach(async () => {
  cleanup()
  stopSignIn()
  await flushPreferences()
  stopWriter()
})

function renderPage() {
  return render(
    <TooltipProvider lookup={getTooltipCopy}>
      <AiTutorSettings />
    </TooltipProvider>,
  )
}

const jsonResponse = (body: unknown): FakeAiEvent[] => [
  { type: 'head', status: 200, headers: [['content-type', 'application/json']] },
  { type: 'chunk', data: toBase64Text(JSON.stringify(body)) },
  { type: 'end' },
]

/** A streamed plain-text reply ("pong"): what a local model that ignores the probe's tool answers. */
const pongStream = (): FakeAiEvent[] =>
  sseResponse([
    `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 0, model: 'llama3', choices: [{ index: 0, delta: { content: 'pong' }, finish_reason: 'stop' }] })}\n\n`,
    'data: [DONE]\n\n',
  ])

const form = () => screen.getByRole('form')
const audit = (where: string) => {
  const problems = auditTooltipCoverage(document.body)
  expect(problems, `${where}: ${formatCoverageProblems(problems)}`).toEqual([])
}

async function addConnection(provider: string, fill: (f: HTMLElement) => void) {
  fireEvent.click(await screen.findByRole('button', { name: 'Add Connection…' }))
  fireEvent.change(within(form()).getByLabelText('Provider'), { target: { value: provider } })
  fill(form())
}

describe('Settings ▸ AI Tutor', () => {
  it('shows the subscription note and the chat history note, and every control has a tooltip', async () => {
    renderPage()
    expect(await screen.findByText(SUBSCRIPTION_NOTE)).toBeInTheDocument()
    expect(screen.getByText(HISTORY_NOTE)).toBeInTheDocument()
    audit('empty')
    fireEvent.click(screen.getByRole('button', { name: 'Add Connection…' }))
    audit('add form')
  })

  it('saving a key never writes it to preferences or connections; it goes to the keychain only', async () => {
    renderPage()
    await addConnection('openai', (f) => fireEvent.change(within(f).getByLabelText('API key'), { target: { value: SECRET } }))
    fireEvent.click(within(form()).getByRole('button', { name: 'Save Connection' }))
    await waitFor(() => expect(screen.queryByRole('form')).toBeNull())
    await flushPreferences()

    const [saved] = backend.ai.connections
    expect(saved).toMatchObject({ provider: 'openai', label: 'OpenAI', auth: 'api_key' })
    expect(backend.ai.secrets.get(saved.id as string)).toBe(SECRET)
    // The fake files: ai-connections.json, preferences.json, and every project-side file.
    expect(JSON.stringify(backend.ai.connections)).not.toContain(SECRET)
    expect(backend.preferences ?? '').not.toContain(SECRET)
    expect(JSON.stringify([...backend.files.values()])).not.toContain(SECRET)
    expect(JSON.stringify(useStore.getState())).not.toContain(SECRET)
    // The new connection is the tutor's default (there was none).
    expect(useStore.getState().tutorConnections.activeId).toBe(saved.id)
    expect(JSON.parse(backend.preferences!).tutorActiveConnection).toBe(saved.id)
  })

  it('the key field is empty when reopened, with "Key saved"', async () => {
    backend.ai.connections = [{ id: 'c1', provider: 'openai', label: 'Work', auth: 'api_key' }]
    backend.ai.secrets.set('c1', SECRET)
    renderPage()
    const row = await screen.findByText('Work', { selector: 'p' })
    await waitFor(() => expect(row.closest('li')).toHaveTextContent('Key saved'))
    fireEvent.click(screen.getByRole('button', { name: 'Edit Work' }))
    const key = within(form()).getByLabelText('API key') as HTMLInputElement
    expect(key.type).toBe('password')
    expect(key.value).toBe('')
    expect(within(form()).getByTestId('ai-key-saved')).toHaveTextContent('Key saved')
    // Saving without typing a key keeps the saved one.
    fireEvent.change(within(form()).getByLabelText('Name'), { target: { value: 'Work account' } })
    fireEvent.click(within(form()).getByRole('button', { name: 'Save Connection' }))
    await waitFor(() => expect(backend.ai.connections[0].label).toBe('Work account'))
    expect(backend.ai.secrets.get('c1')).toBe(SECRET)
    // A replaced key: the field empties again once saved.
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Work account' }))
    fireEvent.change(within(form()).getByLabelText('API key'), { target: { value: 'sk-new' } })
    fireEvent.click(within(form()).getByRole('button', { name: 'Save Connection' }))
    await waitFor(() => expect(backend.ai.secrets.get('c1')).toBe('sk-new'))
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Work account' }))
    expect((within(form()).getByLabelText('API key') as HTMLInputElement).value).toBe('')
  })

  it('plain http to another computer needs the confirmation; https and this computer do not', async () => {
    renderPage()
    await addConnection('custom', (f) => fireEvent.change(within(f).getByLabelText('Server address'), { target: { value: 'http://192.168.1.20:8080/v1' } }))
    fireEvent.click(within(form()).getByRole('button', { name: 'Save Connection' }))
    let ask = await screen.findByRole('dialog', { name: 'Send your text unencrypted?' })
    expect(ask).toHaveTextContent('192.168.1.20:8080')
    audit('insecure confirm')
    fireEvent.click(within(ask).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(backend.ai.connections).toEqual([])
    // Asked again, and accepted.
    fireEvent.click(within(form()).getByRole('button', { name: 'Save Connection' }))
    ask = await screen.findByRole('dialog', { name: 'Send your text unencrypted?' })
    fireEvent.click(within(ask).getByRole('button', { name: 'Use Unencrypted Address' }))
    await waitFor(() => expect(backend.ai.connections).toHaveLength(1))
    expect(backend.ai.connections[0]).toMatchObject({ provider: 'custom', baseUrl: 'http://192.168.1.20:8080/v1', insecureHttpAccepted: true })

    // R8: *.localhost is not this computer.
    await addConnection('custom', (f) => fireEvent.change(within(f).getByLabelText('Server address'), { target: { value: 'http://foo.localhost:1234/v1' } }))
    fireEvent.click(within(form()).getByRole('button', { name: 'Save Connection' }))
    ask = await screen.findByRole('dialog', { name: 'Send your text unencrypted?' })
    fireEvent.click(within(ask).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    // Loopback and https save without asking; Ollama gets its /v1.
    fireEvent.change(within(form()).getByLabelText('Provider'), { target: { value: 'ollama' } })
    fireEvent.change(within(form()).getByLabelText('Server address'), { target: { value: 'http://localhost:11434' } })
    fireEvent.click(within(form()).getByRole('button', { name: 'Save Connection' }))
    await waitFor(() => expect(backend.ai.connections).toHaveLength(2))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(backend.ai.connections[1]).toMatchObject({ provider: 'ollama', auth: 'none', baseUrl: 'http://localhost:11434/v1' })
    expect(backend.ai.connections[1].insecureHttpAccepted).toBeUndefined()
  })

  it('a changed host is asked about again', async () => {
    backend.ai.connections = [{ id: 'lan', provider: 'custom', label: 'LAN', auth: 'api_key', baseUrl: 'http://192.168.1.20/v1', insecureHttpAccepted: true }]
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: 'Edit LAN' }))
    fireEvent.click(within(form()).getByRole('button', { name: 'Save Connection' }))
    await waitFor(() => expect(screen.queryByRole('form')).toBeNull())
    expect(screen.queryByRole('dialog')).toBeNull() // the same host, already accepted
    fireEvent.click(await screen.findByRole('button', { name: 'Edit LAN' }))
    fireEvent.change(within(form()).getByLabelText('Server address'), { target: { value: 'http://192.168.1.99/v1' } })
    fireEvent.click(within(form()).getByRole('button', { name: 'Save Connection' }))
    expect(await screen.findByRole('dialog', { name: 'Send your text unencrypted?' })).toHaveTextContent('192.168.1.99')
  })

  it('Clear All calls tutor_history_clear_all after a confirmation; Clear This Project needs an open project', async () => {
    backend.ai.history.set('p1', new Map([['c1', { id: 'c1', title: 'A', updatedAt: '1' }]]))
    backend.ai.history.set('p2', new Map([['c2', { id: 'c2', title: 'B', updatedAt: '1' }]]))
    const handle = vi.spyOn(core, 'handle')
    renderPage()
    expect(screen.getByRole('button', { name: "Clear This Project's Chats" })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Clear All Chats' }))
    const ask = await screen.findByRole('dialog', { name: 'Clear all chats?' })
    expect(handle.mock.calls.some(([cmd]) => cmd === 'tutor_history_clear_all')).toBe(false)
    fireEvent.click(within(ask).getByRole('button', { name: 'Clear All Chats' }))
    await waitFor(() => expect(handle.mock.calls.some(([cmd]) => cmd === 'tutor_history_clear_all')).toBe(true))
    expect(backend.ai.history.size).toBe(0)
    expect(await screen.findByTestId('ai-history-status')).toHaveTextContent('All chats were deleted.')
    handle.mockRestore()
  })

  it('Sign in with OpenRouter: Rust opens the browser; the result adds the connection and makes it the default', async () => {
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in with OpenRouter' }))
    await waitFor(() => expect(backend.ai.oauthStarts).toEqual(['openrouter']))
    expect(screen.getByTestId('ai-sign-in-status')).toHaveTextContent('Finish signing in to OpenRouter in your browser')
    expect(screen.getByRole('button', { name: 'Sign in with OpenRouter' })).toBeDisabled()
    audit('waiting')
    // Rust finishes: the key is in the keychain, the connection saved; the event carries its id only.
    const id = core.completeOAuth('sk-or-v1-SECRET')
    act(() => emit('ai-oauth-result', { ok: true, connectionId: id }))
    await waitFor(() => expect(screen.getByTestId('ai-sign-in-status')).toHaveTextContent('Signed in. “OpenRouter” is ready to use.'))
    expect(useStore.getState().tutorConnections.activeId).toBe(id)
    const row = screen.getByText('OpenRouter', { selector: 'p' }).closest('li')!
    expect(row).toHaveTextContent('Signed in')
    expect(document.body.textContent).not.toContain('sk-or-v1-SECRET')
    // The connection form for a signed-in connection has no key field.
    fireEvent.click(within(row).getByRole('button', { name: 'Edit OpenRouter' }))
    expect(within(form()).queryByLabelText('API key')).toBeNull()
    expect(form()).toHaveTextContent('Signed in with OpenRouter')
  })

  it('Continue with ChatGPT: the ban warning comes once, before the first sign-in; Cancel starts nothing', async () => {
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: 'Continue with ChatGPT' }))
    const warning = await screen.findByRole('dialog', { name: 'Before you sign in with your ChatGPT plan' })
    expect(within(warning).getByTestId('ai-plan-warning')).toHaveTextContent('governed by the provider\'s terms of use')
    expect(within(warning).getByTestId('ai-plan-warning')).toHaveTextContent('at your own risk')
    audit('ban warning')
    fireEvent.click(within(warning).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(backend.ai.oauthStarts).toEqual([])
    expect(useStore.getState().preferences.tutorPlanWarningSeen).toBe(false)
    // Continue: remembered, and Rust opens the browser.
    fireEvent.click(screen.getByRole('button', { name: 'Continue with ChatGPT' }))
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Continue to Sign In' }))
    await waitFor(() => expect(backend.ai.oauthStarts).toEqual(['chatgpt']))
    expect(useStore.getState().preferences.tutorPlanWarningSeen).toBe(true)
    expect(screen.getByTestId('ai-sign-in-status')).toHaveTextContent('Finish signing in to ChatGPT in your browser')
    // Rust finishes: the token record is in the keychain; the event carries the id only.
    const id = core.completeOAuth('{"v":1,"accessToken":"TOKEN-SECRET"}', 'chatgpt', 'ChatGPT (writer@example.com)')
    act(() => emit('ai-oauth-result', { ok: true, connectionId: id }))
    await waitFor(() => expect(screen.getByTestId('ai-sign-in-status')).toHaveTextContent('the tutor now uses your ChatGPT plan'))
    expect(useStore.getState().tutorConnections.activeId).toBe(id)
    const row = screen.getByText('ChatGPT (writer@example.com)', { selector: 'p' }).closest('li')!
    expect(row).toHaveTextContent('Signed in · Using your ChatGPT plan')
    expect(document.body.textContent).not.toContain('TOKEN-SECRET')
    // The second sign-in goes straight to the browser.
    fireEvent.click(screen.getByRole('button', { name: 'Continue with ChatGPT' }))
    await waitFor(() => expect(backend.ai.oauthStarts).toEqual(['chatgpt', 'chatgpt']))
    expect(screen.queryByRole('dialog')).toBeNull()
    audit('signed in')
  })

  it('a ChatGPT connection: Manage Usage, Sign In Again (same connection), and Remove signs out', async () => {
    backend.ai.connections = [{ id: 'gpt', provider: 'chatgpt', label: 'ChatGPT', auth: 'oauth' }]
    backend.ai.secrets.set('gpt', '{"v":1}')
    useStore.getState().preferencesActions.set('tutorPlanWarningSeen', true)
    renderPage()
    const row = (await screen.findByText('ChatGPT', { selector: 'p' })).closest('li')!
    fireEvent.click(within(row).getByRole('button', { name: 'Manage Usage ChatGPT' }))
    await waitFor(() => expect(backend.ai.usagePages).toEqual(['chatgpt']))
    fireEvent.click(within(row).getByRole('button', { name: 'Sign In Again ChatGPT' }))
    await waitFor(() => expect(backend.ai.oauthRenewals).toEqual(['gpt']))
    act(() => emit('ai-oauth-result', { ok: true, connectionId: 'gpt' }))
    await waitFor(() => expect(screen.getByTestId('ai-sign-in-status')).toHaveTextContent('Signed in again. “ChatGPT” is ready to use.'))
    expect(backend.ai.connections).toHaveLength(1)
    // The form of a sign-in has no key field and says how to renew.
    fireEvent.click(within(row).getByRole('button', { name: 'Edit ChatGPT' }))
    expect(within(form()).queryByLabelText('API key')).toBeNull()
    expect(form()).toHaveTextContent('Signed in with ChatGPT. If the sign-in has ended, use Sign In Again.')
    fireEvent.click(within(form()).getByRole('button', { name: 'Cancel' }))
    // Remove: Rust signs out; when OpenAI does not confirm, the page says where to disconnect.
    backend.ai.signOutConfirmed = false
    fireEvent.click(within(row).getByRole('button', { name: 'Remove ChatGPT' }))
    const ask = await screen.findByRole('dialog', { name: 'Remove “ChatGPT”?' })
    expect(ask).toHaveTextContent('Novel signs out of ChatGPT')
    fireEvent.click(within(ask).getByRole('button', { name: 'Remove Connection' }))
    await waitFor(() => expect(backend.ai.connections).toEqual([]))
    expect(backend.ai.secrets.has('gpt')).toBe(false)
    expect(screen.getByTestId('ai-settings-list-status')).toHaveTextContent('ChatGPT did not confirm the sign-out')
  })

  it('a known ChatGPT account: Continue reuses it, Use Another Account registers another (N1)', async () => {
    backend.ai.reusableAccount = 'writer@example.com'
    useStore.getState().preferencesActions.set('tutorPlanWarningSeen', true)
    renderPage()
    expect(await screen.findByTestId('ai-sign-in-reuse')).toHaveTextContent(
      'Continue with ChatGPT signs in again as writer@example.com. To add a different account, use Use Another Account.',
    )
    audit('reuse offered')
    fireEvent.click(screen.getByRole('button', { name: 'Use Another Account' }))
    await waitFor(() => expect(backend.ai.oauthStarts).toEqual(['chatgpt']))
    expect(backend.ai.oauthNewAccounts).toEqual(['chatgpt'])
    expect(screen.getByRole('button', { name: 'Use Another Account' })).toBeDisabled()
    act(() => emit('ai-oauth-result', { ok: false, error: 'The sign-in timed out. Try again.' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Use Another Account' })).toBeEnabled())
    // The plain button reuses (Rust decides; no newAccount flag is sent).
    fireEvent.click(screen.getByRole('button', { name: 'Continue with ChatGPT' }))
    await waitFor(() => expect(backend.ai.oauthStarts).toEqual(['chatgpt', 'chatgpt']))
    expect(backend.ai.oauthNewAccounts).toEqual(['chatgpt'])
  })

  it('Use Another Account also shows the ban warning first when it was never read', async () => {
    backend.ai.reusableAccount = ''
    renderPage()
    expect(await screen.findByTestId('ai-sign-in-reuse')).toHaveTextContent('signs in again as the account you used before')
    fireEvent.click(screen.getByRole('button', { name: 'Use Another Account' }))
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Before you sign in with your ChatGPT plan' })).getByRole('button', { name: 'Continue to Sign In' }))
    await waitFor(() => expect(backend.ai.oauthNewAccounts).toEqual(['chatgpt']))
  })

  it('no known account: no Use Another Account and no reuse note', async () => {
    renderPage()
    await screen.findByRole('button', { name: 'Continue with ChatGPT' })
    await waitFor(() => expect(screen.queryByTestId('ai-sign-in-reuse')).toBeNull())
    expect(screen.queryByRole('button', { name: 'Use Another Account' })).toBeNull()
  })

  it('ChatGPT is a sign-in only: it is not in Add Connection’s provider list', async () => {
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: 'Add Connection…' }))
    const options = within(within(form()).getByLabelText('Provider')).getAllByRole('option').map((o) => (o as HTMLOptionElement).value)
    expect(options).not.toContain('chatgpt')
    expect(options).toContain('openrouter')
  })

  it('a failed or cancelled sign-in says so and adds nothing', async () => {
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in with OpenRouter' }))
    await waitFor(() => expect(backend.ai.oauthStarts).toHaveLength(1))
    act(() => emit('ai-oauth-result', { ok: false, error: 'The sign-in timed out. Try again.' }))
    await waitFor(() => expect(screen.getByTestId('ai-sign-in-status')).toHaveTextContent('The sign-in timed out. Try again.'))
    expect(backend.ai.connections).toEqual([])
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with OpenRouter' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel Sign-in' }))
    await waitFor(() => expect(backend.ai.oauthCancels).toBe(1))
    act(() => emit('ai-oauth-result', { ok: false, error: 'The request was cancelled.' }))
    expect(screen.getByTestId('ai-sign-in-status')).toHaveTextContent('')
    expect(screen.queryByRole('button', { name: 'Cancel Sign-in' })).toBeNull()
  })

  it('a sign-in finished after Settings was closed still adds the connection', async () => {
    const { unmount } = renderPage()
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in with OpenRouter' }))
    await waitFor(() => expect(backend.ai.oauthStarts).toHaveLength(1))
    unmount()
    const id = core.completeOAuth('sk-or-v1-x')
    act(() => emit('ai-oauth-result', { ok: true, connectionId: id }))
    await waitFor(() => expect(useStore.getState().tutorConnections.list.map((c) => c.id)).toEqual([id]))
  })

  it('I1: a sign-in that finishes during a slow Test Connection survives the writes of the test (connection and key)', async () => {
    backend.ai.connections = [{ id: 'local', provider: 'ollama', label: 'Ollama', auth: 'none', baseUrl: 'http://localhost:11434/v1' }]
    // The probe (POST /chat/completions) waits on a gate: a slow local model.
    let release = () => {}
    const gate = new Promise<void>((r) => (release = r))
    let probing = false
    const original = core.handle.bind(core)
    const handle = vi.spyOn(core, 'handle').mockImplementation(async (cmd, args, options) => {
      if (cmd === 'ai_fetch' && (args as { req: { path: string } }).req.path === '/chat/completions') {
        probing = true
        await gate
      }
      return original(cmd, args, options)
    })
    try {
      renderPage()
      fireEvent.click(await screen.findByRole('button', { name: 'Sign in with OpenRouter' }))
      await waitFor(() => expect(backend.ai.oauthStarts).toHaveLength(1))
      fireEvent.click(screen.getByRole('button', { name: 'Edit Ollama' }))
      backend.ai.queue.push(
        { events: jsonResponse({ data: [{ id: 'llama3' }] }) },
        { events: pongStream() },
      )
      fireEvent.click(within(form()).getByRole('button', { name: 'Test Connection' }))
      await waitFor(() => expect(probing).toBe(true))
      // The browser comes back while the probe runs.
      const id = core.completeOAuth('sk-or-v1-RACE')
      act(() => emit('ai-oauth-result', { ok: true, connectionId: id }))
      await waitFor(() => expect(screen.getByTestId('ai-sign-in-status')).toHaveTextContent('Signed in.'))
      release()
      await waitFor(() => expect(within(form()).getByTestId('ai-settings-form-status')).toHaveTextContent('did not call a tool'))
      expect(backend.ai.connections.map((c) => c.id)).toEqual(['local', id])
      expect(backend.ai.secrets.get(id)).toBe('sk-or-v1-RACE')
      expect(backend.ai.connections[0]).toMatchObject({ toolSupport: { llama3: false } })
      // Then Save (the form opened before the sign-in), and Remove of the other connection: both keep it.
      fireEvent.click(within(form()).getByRole('button', { name: 'Save Connection' }))
      await waitFor(() => expect(screen.queryByRole('form')).toBeNull())
      expect(backend.ai.connections.map((c) => c.id)).toEqual(['local', id])
      expect(backend.ai.secrets.get(id)).toBe('sk-or-v1-RACE')
      expect(useStore.getState().tutorConnections.list.map((c) => c.id)).toEqual(['local', id])
    } finally {
      release()
      handle.mockRestore()
    }
  })

  it('I1: Remove never writes a list captured before a sign-in finished', async () => {
    backend.ai.connections = [{ id: 'a', provider: 'openai', label: 'A', auth: 'api_key' }]
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: 'Remove A' }))
    const ask = await screen.findByRole('dialog', { name: 'Remove “A”?' })
    // Rust adds a signed-in connection while the question is open; the page has not heard yet.
    const id = core.completeOAuth('sk-or-v1-LATE')
    fireEvent.click(within(ask).getByRole('button', { name: 'Remove Connection' }))
    await waitFor(() => expect(backend.ai.connections.map((c) => c.id)).toEqual([id]))
    expect(backend.ai.secrets.get(id)).toBe('sk-or-v1-LATE')
  })

  it('Get a Key opens the provider page through Rust (by provider, never a URL)', async () => {
    renderPage()
    await addConnection('deepseek', () => {})
    fireEvent.click(within(form()).getByRole('button', { name: 'Get a Key' }))
    await waitFor(() => expect(backend.ai.keyPages).toEqual(['deepseek']))
    // Local servers have no key and no key page.
    fireEvent.change(within(form()).getByLabelText('Provider'), { target: { value: 'lmstudio' } })
    expect(within(form()).queryByLabelText('API key')).toBeNull()
    expect(within(form()).queryByRole('button', { name: 'Get a Key' })).toBeNull()
  })

  it('Test Connection lists the models and probes a local model for tools; the override is saved', async () => {
    renderPage()
    await addConnection('ollama', () => {})
    backend.ai.queue.push(
      { events: jsonResponse({ data: [{ id: 'llama3' }, { id: 'qwen3' }] }) },
      // The probe: a plain text reply, no tool call.
      { events: sseResponse([`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 0, model: 'llama3', choices: [{ index: 0, delta: { content: 'pong' }, finish_reason: 'stop' }] })}\n\n`, 'data: [DONE]\n\n']) },
    )
    fireEvent.click(within(form()).getByRole('button', { name: 'Test Connection' }))
    await waitFor(() => expect(within(form()).getByTestId('ai-settings-form-status')).toHaveTextContent('Connected. 2 models found.'))
    expect(within(form()).getByTestId('ai-settings-form-status')).toHaveTextContent('llama3 did not call a tool')
    expect(backend.ai.requests.map((r) => r.req.path)).toEqual(['/models', '/chat/completions'])
    // Nothing of a manuscript in the probe.
    expect(JSON.parse(backend.ai.requests[1].req.body!).messages.at(-1).content).toMatch(/ping/)
    expect(backend.ai.connections[0]).toMatchObject({ provider: 'ollama', defaultModel: 'llama3', toolSupport: { llama3: false } })
    const override = within(form()).getByRole('checkbox', { name: 'This model supports tools' }) as HTMLInputElement
    expect(override.checked).toBe(false)
    audit('tested')
    fireEvent.click(override)
    fireEvent.click(within(form()).getByRole('button', { name: 'Save Connection' }))
    await waitFor(() => expect(backend.ai.connections[0].toolSupport).toEqual({ llama3: true }))
  })

  it('Test Connection reports a refused key instead of falling back to the curated list', async () => {
    renderPage()
    await addConnection('openai', (f) => fireEvent.change(within(f).getByLabelText('API key'), { target: { value: 'sk-wrong' } }))
    backend.ai.queue.push({ events: [{ type: 'head', status: 401, headers: [] }, { type: 'end' }] })
    fireEvent.click(within(form()).getByRole('button', { name: 'Test Connection' }))
    await waitFor(() => expect(within(form()).getByTestId('ai-settings-form-status')).toHaveTextContent(/The test failed.*401/))
    expect(within(form()).getByTestId('ai-settings-form-status').textContent).not.toContain('sk-wrong')
    expect((within(form()).getByLabelText('API key') as HTMLInputElement).value).toBe('')
  })

  it('a hosted model of unknown tool support gets the override; one known not to says not supported', async () => {
    backend.ai.connections = [{ id: 'or', provider: 'openrouter', label: 'OR', auth: 'api_key' }]
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: 'Edit OR' }))
    backend.ai.queue.push({
      events: jsonResponse({ data: [{ id: 'a/tools', supported_parameters: ['tools'] }, { id: 'b/none', supported_parameters: [] }] }),
    })
    fireEvent.click(within(form()).getByRole('button', { name: 'Test Connection' }))
    await waitFor(() => expect(within(form()).getByTestId('ai-settings-form-status')).toHaveTextContent('2 models found'))
    const model = within(form()).getByLabelText('Default model')
    expect(within(model).getByRole('option', { name: "b/none (can't use tools)" })).toBeInTheDocument()
    fireEvent.change(model, { target: { value: 'b/none' } })
    expect(within(form()).getByTestId('ai-model-no-tools')).toHaveTextContent('Not supported')
    expect(within(form()).queryByRole('checkbox')).toBeNull()
    fireEvent.change(model, { target: { value: 'a/tools' } })
    expect(within(form()).queryByTestId('ai-model-no-tools')).toBeNull()
    expect(within(form()).queryByRole('checkbox')).toBeNull()
  })

  it('Set as Default and Remove (with a confirmation that deletes the key)', async () => {
    backend.ai.connections = [
      { id: 'a', provider: 'openai', label: 'A', auth: 'api_key' },
      { id: 'b', provider: 'xai', label: 'B', auth: 'api_key' },
    ]
    backend.ai.secrets.set('b', 'k')
    await loadTutorConnections()
    renderPage()
    const rowB = (await screen.findByText('B', { selector: 'p' })).closest('li')!
    expect(screen.getByText('A', { selector: 'p' }).closest('li')).toHaveTextContent('(Default)')
    fireEvent.click(within(rowB).getByRole('button', { name: 'Set as Default B' }))
    expect(useStore.getState().tutorConnections.activeId).toBe('b')
    fireEvent.click(within(rowB).getByRole('button', { name: 'Remove B' }))
    const ask = await screen.findByRole('dialog', { name: 'Remove “B”?' })
    fireEvent.click(within(ask).getByRole('button', { name: 'Remove Connection' }))
    await waitFor(() => expect(backend.ai.connections.map((c) => c.id)).toEqual(['a']))
    expect(backend.ai.secrets.has('b')).toBe(false)
    expect(useStore.getState().tutorConnections.activeId).toBe('a')
  })
})
