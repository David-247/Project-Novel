import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test'
import { flushWordCount, getEditor, setDocJSON } from '@/features/editor'
import { auditTooltipCoverage, formatCoverageProblems } from '@/features/tooltips'
import { buildMenuModel, getCommand, getCommands, runCommand, type MenuNode } from '@/shared/commands'
import { useStore, type PageInfo } from '@/shared/store'
import { backend } from '@/test-utils/fake-tauri'

vi.mock('@tauri-apps/api/core', async () => (await import('@/test-utils/fake-tauri')).coreModule)
vi.mock('@tauri-apps/plugin-dialog', async () => (await import('@/test-utils/fake-tauri')).dialogModule)
vi.mock('@tauri-apps/plugin-sql', async () => (await import('@/test-utils/fake-tauri')).sqlModule)
// The window and event APIs the whole app touches (theme, close request, native menu events).
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    theme: async () => null,
    onThemeChanged: async () => () => {},
    onCloseRequested: async () => () => {},
    destroy: async () => {},
    isFullscreen: async () => false,
    setFullscreen: async () => {},
  }),
}))
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }))
vi.mock('@tauri-apps/api/app', () => ({ getVersion: async () => '0.5.0' }))

// The fake provider: the AI SDK's mock model behind a test adapter (no request reaches ai_fetch).
const hoisted = vi.hoisted(() => ({ model: null as unknown }))
vi.mock('@/features/ai-tutor/providers/registry', () => ({
  getAdapter: () => ({
    label: 'Test provider',
    connectKinds: ['api_key'],
    languageModel: () => hoisted.model,
    listModels: async () => [
      { id: 'gpt-test', label: 'GPT Test', tools: 'yes' },
      { id: 'tiny', label: 'Tiny', tools: 'unknown' },
    ],
  }),
  listAdapters: () => [],
  modelSupportsTools: (c: { toolSupport?: Record<string, boolean> }, m: { id: string; tools: string }) => c.toolSupport?.[m.id] ?? m.tools === 'yes',
}))

import { AI_SETTINGS_PAGE_ID, closeTutor, isTutorOpen, TUTOR_CONTROLS as C, TUTOR_SHORTCUT, useTutorHistory } from '@/features/ai-tutor'
import { closeSettings, openSettings } from '@/features/settings'
import { closeProject, openProject, saveProject } from '@/features/storage'
import { App } from './App'

type StreamPart = Awaited<ReturnType<MockLanguageModelV4['doStream']>>['stream'] extends ReadableStream<infer P> ? P : never
type CallOptions = Parameters<MockLanguageModelV4['doStream']>[0]

beforeAll(() => {
  const rect = { x: 0, y: 0, top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0, toJSON: () => ({}) }
  const emptyRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList
  Range.prototype.getClientRects ??= emptyRects
  Range.prototype.getBoundingClientRect ??= () => rect as DOMRect
  Element.prototype.getClientRects ??= emptyRects
  Element.prototype.scrollIntoView ??= () => {}
  Element.prototype.hasPointerCapture ??= () => false
  Element.prototype.setPointerCapture ??= () => {}
  Element.prototype.releasePointerCapture ??= () => {}
  document.elementFromPoint ??= () => null
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})

const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } }
const finish = (unified: 'stop' | 'tool-calls'): StreamPart => ({ type: 'finish', finishReason: { unified, raw: unified }, usage })
const text = (...deltas: string[]): StreamPart[] => [{ type: 'text-start', id: 't' }, ...deltas.map((delta) => ({ type: 'text-delta' as const, id: 't', delta })), { type: 'text-end', id: 't' }]
let callId = 0
const call = (toolName: string, input: unknown): StreamPart => ({ type: 'tool-call', toolCallId: `call-${++callId}`, toolName, input: JSON.stringify(input) })
type Step = StreamPart[] | ((options: CallOptions) => ReadableStream<StreamPart> | Promise<never>)
function scripted(...steps: Step[]): MockLanguageModelV4 {
  let n = 0
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      const step = steps[n++]
      if (!step) throw new Error('the script ran out')
      return { stream: typeof step === 'function' ? await step(options) : convertArrayToReadableStream(step) }
    },
  })
  hoisted.model = model
  return model
}

const t = (s: string) => ({ type: 'text', text: s })
const DOC = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 1 }, content: [t('One')] },
    { type: 'paragraph', content: [t('I saw teh dog.')] },
    { type: 'paragraph', content: [t('It ran acros the road.')] },
    { type: 'heading', attrs: { level: 1 }, content: [t('Two')] },
    { type: 'paragraph', content: [t('Far away.')] },
  ],
}
const CONNECTION = { id: 'conn-1', provider: 'openai', label: 'OpenAI', auth: 'api_key', defaultModel: 'gpt-test' }

const page = (index: number, from: number, to: number, chapterIndex: number): PageInfo => ({ index, side: index % 2 === 0 ? 'recto' : 'verso', from, to, isBlank: false, startsBlockType: null, chapterIndex })

function blockPos(i: number): number {
  const doc = getEditor()!.state.doc
  let pos = 0
  for (let k = 0; k < i; k++) pos += doc.child(k).nodeSize
  return pos
}

function layOut() {
  const end = getEditor()!.state.doc.content.size
  if (getEditor()!.state.doc.childCount < 4) {
    useStore.getState().layoutActions.setPages([page(0, 0, end, 0)])
    useStore.getState().layoutActions.setCurrentPage(0)
    return
  }
  const two = blockPos(3)
  useStore.getState().layoutActions.setPages([page(0, 0, two, 0), page(1, two, end, 1)])
  useStore.getState().layoutActions.setCurrentPage(0)
}

async function renderApp({ connected = true } = {}) {
  backend.ai.connections = connected ? [CONNECTION] : []
  render(<App />)
  await waitFor(() => expect(getEditor()).not.toBeNull())
  await waitFor(() => expect(getCommand(C.toggle.id)).toBeDefined())
  act(() => setDocJSON(DOC as Parameters<typeof setDocJSON>[0]))
  act(() => flushWordCount())
  act(() => layOut())
  if (connected) await waitFor(() => expect(useStore.getState().tutorConnections.activeId).toBe(CONNECTION.id))
}

const panel = () => screen.getByTestId('tutor-panel')
const inPanel = (id: string) => panel().querySelector<HTMLElement>(`[data-control-id="${id}"]`)!
const composer = () => inPanel(C.composer.id) as HTMLTextAreaElement
const idle = async () => {
  const { useTutorChat } = await import('@/features/ai-tutor/panel/chat')
  await waitFor(() => expect(useTutorChat.getState().busy).toBe(false))
}
const audit = (where: string) => {
  const problems = auditTooltipCoverage(document.body)
  expect(problems, `${where}: ${formatCoverageProblems(problems)}`).toEqual([])
}
const focusComposer = () => waitFor(() => expect(document.activeElement).toBe(composer()))
async function openMenu(id: string) {
  await focusComposer()
  fireEvent.keyDown(inPanel(id), { key: 'Enter' })
  return screen.findByRole('menu')
}

beforeEach(() => {
  backend.reset()
  hoisted.model = null
})
afterEach(async () => {
  act(() => closeTutor())
  act(() => closeSettings())
  cleanup()
  setDocJSON({ type: 'doc', content: [{ type: 'paragraph' }] })
  useStore.getState().layoutActions.resetLayout()
})

describe('the tutor in the app', () => {
  it('View ▸ Tutor (Ctrl/Cmd+Shift+Y), Review ▸ Proofing ▸ Tutor and View ▸ Show ▸ Tutor open and close the docked panel', async () => {
    await renderApp()
    const cmd = getCommand(C.toggle.id)!
    expect(cmd.shortcut).toBe('Mod-Shift-y')
    expect(TUTOR_SHORTCUT).toBe('Mod-Shift-y')
    const view = buildMenuModel(getCommands(), 'in-app').find((m) => m.id === 'view')!
    const labels = (nodes: MenuNode[]): string[] => nodes.flatMap((n) => (n.kind === 'item' ? [n.command.label] : n.kind === 'submenu' ? labels(n.children) : []))
    expect(labels(view.children)).toContain('Tutor')
    // The ribbon: Review ▸ Proofing (with the sparkle) and View ▸ Show.
    const buttons = document.querySelectorAll<HTMLElement>(`[data-control-id="ribbon.cmd.${C.toggle.id}"]`)
    expect(buttons).toHaveLength(2)
    expect(buttons[0].closest('[data-ribbon-panel]')?.getAttribute('data-ribbon-panel')).toBe('review')
    expect(buttons[0].closest('[data-ribbon-group]')?.getAttribute('data-ribbon-group')).toBe('review.proofing')
    expect(buttons[0].querySelector('svg')).not.toBeNull()
    expect(buttons[1].closest('[data-ribbon-panel]')?.getAttribute('data-ribbon-panel')).toBe('view')
    fireEvent.click(buttons[0])
    expect(panel()).toBeInTheDocument()
    expect(buttons[0]).toHaveAttribute('aria-pressed', 'true')
    // Docked beside the pages, inside the editor region's row.
    expect(panel().parentElement).toBe(screen.getByRole('main').parentElement)
    expect(panel()).not.toHaveAttribute('data-overlay')
    act(() => void runCommand(C.toggle.id))
    expect(screen.queryByRole('complementary', { name: 'Tutor' })).toBeNull()
    expect(isTutorOpen()).toBe(false)
  })

  it('Ctrl+Shift+Y toggles it from the manuscript', async () => {
    await renderApp()
    getEditor()!.view.focus()
    fireEvent.keyDown(getEditor()!.view.dom, { key: 'Y', code: 'KeyY', ctrlKey: true, shiftKey: true, metaKey: false })
    fireEvent.keyDown(getEditor()!.view.dom, { key: 'Y', code: 'KeyY', metaKey: true, shiftKey: true, ctrlKey: false })
    // One of the two is Mod on this platform: the panel is open after it, and only once toggled.
    expect(isTutorOpen()).toBe(true)
  })

  it('nothing reaches ai_fetch while the panel opens, chips are added and text is typed', async () => {
    const model = scripted([...text('Hello.'), finish('stop')])
    await renderApp()
    act(() => void runCommand(C.toggle.id))
    fireEvent.click(await within(await openMenu(C.attach.id)).findByRole('menuitem', { name: /Current Page/ }))
    fireEvent.change(composer(), { target: { value: 'Anything wrong here?' } })
    expect(model.doStreamCalls).toHaveLength(0)
    expect(backend.ai.requests).toHaveLength(0)
    fireEvent.keyDown(composer(), { key: 'Enter' })
    await idle()
    expect(model.doStreamCalls).toHaveLength(1)
    expect(backend.ai.requests).toHaveLength(0)
  })
})

describe('tooltip and keyboard audits of the tutor panel', () => {
  /** Every control in the panel is reachable from the keyboard: focusable, not removed from the tab order. */
  function keyboardAudit(where: string) {
    const unreachable = Array.from(panel().querySelectorAll<HTMLElement>('[data-control-id]'))
      .filter((el) => el.getAttribute('aria-hidden') !== 'true')
      .filter((el) => (el as HTMLButtonElement).disabled !== true)
      .filter((el) => el.tabIndex < 0)
      .map((el) => el.getAttribute('data-control-id'))
    expect(unreachable, `${where}: not reachable by Tab`).toEqual([])
  }

  it('the greeting, the + menu and its chapter list, the model picker, a turn with corrections, a proposal, a read request and an error, the history', async () => {
    await renderApp()
    act(() => void runCommand(C.toggle.id))
    audit('greeting')
    keyboardAudit('greeting')
    const ids = () => Array.from(panel().querySelectorAll('[data-control-id]'), (e) => e.getAttribute('data-control-id'))
    expect(new Set(ids())).toEqual(new Set([C.history.id, C.newChat.id, C.close.id, C.prompt.id, C.composer.id, C.attach.id, C.send.id, C.model.id]))

    // The + menu, then its chapter submenu (ArrowRight on Current Chapter).
    const plus = await openMenu(C.attach.id)
    expect(within(plus).getAllByRole('menuitem').map((i) => i.getAttribute('data-control-id'))).toEqual([C.attachPage.id, C.attachChapter.id, C.attachSelection.id, C.attachManuscript.id])
    audit('+ menu')
    const sub = within(plus).getByRole('menuitem', { name: /Current Chapter/ })
    sub.focus()
    fireEvent.keyDown(sub, { key: 'ArrowRight' })
    const menus = await screen.findAllByRole('menu')
    await waitFor(() => expect(screen.getAllByRole('menu').length).toBeGreaterThan(1))
    const chapters = screen.getAllByRole('menu').at(-1)!
    expect(within(chapters).getAllByRole('menuitem').map((i) => i.textContent)).toEqual([expect.stringMatching(/^1One \(current\)\d+ words?$/), expect.stringMatching(/^2Two\d+ words?$/)])
    void menus
    audit('chapter submenu')
    fireEvent.click(within(chapters).getAllByRole('menuitem')[1])
    expect(panel().querySelectorAll('[data-testid="tutor-chip"]')).toHaveLength(1)
    audit('a chip')
    keyboardAudit('a chip')

    // The model picker (the models are listed as it opens).
    const picker = await openMenu(C.model.id)
    await within(picker).findByRole('menuitem', { name: /Tiny/ })
    audit('model picker')
    fireEvent.keyDown(picker, { key: 'Escape' })

    // A turn: corrections, a proposal and a read request, then an error with Retry.
    scripted(
      [
        call('list_corrections', { items: [{ paragraph: 'p2', kind: 'spelling', original: 'Far', suggestion: 'For', explanation: 'Example.' }] }),
        call('propose_change', { paragraphIds: ['p2'], revisedText: ['Far away!'], reason: 'Punctuation.' }),
        call('read_range', { kind: 'chapter', number: 1 }),
        finish('tool-calls'),
      ],
      () => Promise.reject(Object.assign(new Error('x'), { name: 'AiFetchError' })),
    )
    await focusComposer()
    fireEvent.change(composer(), { target: { value: 'Check chapter two.' } })
    fireEvent.keyDown(composer(), { key: 'Enter' })
    const read = await screen.findByTestId('tutor-read-request')
    await waitFor(() => expect(panel().querySelector('[data-correction-id]')).not.toBeNull())
    expect(panel().querySelector('[data-control-id="tutor.stop"]')).not.toBeNull()
    audit('streaming: corrections, a proposal, a read request, Stop')
    keyboardAudit('streaming')
    fireEvent.click(within(read).getByRole('button', { name: 'Allow' }))
    await idle()
    expect(screen.getByTestId('tutor-error')).toBeInTheDocument()
    expect(inPanel(C.retry.id)).not.toBeNull()
    audit('an error with Retry')
    keyboardAudit('an error with Retry')

    // The history view.
    fireEvent.click(inPanel(C.history.id))
    await screen.findByTestId('tutor-history')
    audit('history')
    keyboardAudit('history')
  })

  it('not connected: the scripted reply and "Connect a Provider…" (opens Settings ▸ AI Tutor)', async () => {
    await renderApp({ connected: false })
    act(() => void runCommand(C.toggle.id))
    await focusComposer()
    fireEvent.change(composer(), { target: { value: 'Hello' } })
    fireEvent.keyDown(composer(), { key: 'Enter' })
    const connect = await within(panel()).findByRole('button', { name: 'Connect a Provider…' })
    audit('not connected')
    fireEvent.click(connect)
    const dialog = await screen.findByRole('dialog', { name: /Settings/ })
    expect(within(dialog).getByRole('tab', { name: 'AI Tutor' })).toHaveAttribute('aria-selected', 'true')
    expect(within(dialog).getByRole('tabpanel')).toHaveTextContent("Claude subscriptions can't be used by other apps (Anthropic's rule). Use an API key or OpenRouter.")
    audit('Settings ▸ AI Tutor')
  })

  it("openSettings('ai-tutor') opens Settings on the AI Tutor page; General is still first", async () => {
    await renderApp()
    act(() => openSettings(AI_SETTINGS_PAGE_ID))
    const dialog = await screen.findByRole('dialog', { name: 'Settings' })
    expect(within(dialog).getAllByRole('tab').map((t) => t.textContent)).toEqual(['General', 'AI Tutor'])
    expect(within(dialog).getByRole('tab', { name: 'AI Tutor' })).toHaveAttribute('aria-selected', 'true')
    expect(within(dialog).getByRole('region', { name: 'Connections' })).toHaveTextContent('OpenAI')
    expect(within(dialog).getByRole('region', { name: 'Chat history' })).toHaveTextContent('Chats are saved on this computer with the text you attached.')
    act(() => closeSettings())
    act(() => openSettings())
    expect((await screen.findByRole('tab', { name: 'General' }))).toHaveAttribute('aria-selected', 'true')
  })
})

describe('projects and history (Review Focus 5)', () => {
  const A = '/books/a'
  const B = '/books/b'
  const seed = (folder: string, id: string, title: string) => {
    backend.dirs.add(folder)
    backend.files.set(`${folder}/project.json`, JSON.stringify({ format: 'novel-project', schemaVersion: 1, id, title, createdAt: 'a', updatedAt: 'b' }))
    backend.files.set(`${folder}/manuscript.json`, JSON.stringify(DOC))
    backend.recent = [...backend.recent, { path: folder, name: title, openedAt: 'a' }]
  }
  async function open(folder: string) {
    backend.answer = "Don't Save"
    const ok = await act(() => openProject(folder))
    expect(ok, JSON.stringify(backend.messages)).toBe(true)
    act(() => layOut())
  }

  it('a chat is saved under its project; another project opening mid-reply stops it and saves nothing there', async () => {
    seed(A, 'proj-a', 'A')
    seed(B, 'proj-b', 'B')
    await renderApp()
    await open(A)
    scripted([...text('First answer.'), finish('stop')])
    act(() => void runCommand(C.toggle.id))
    await focusComposer()
    fireEvent.change(composer(), { target: { value: 'First question' } })
    fireEvent.keyDown(composer(), { key: 'Enter' })
    await idle()
    await act(() => useTutorHistory.getState().flush())
    expect([...(backend.ai.history.get('proj-a')?.values() ?? [])].map((c) => c.title)).toEqual(['First question'])

    let aborted = false
    scripted(
      (options) =>
        new ReadableStream<StreamPart>({
          start(c) {
            c.enqueue({ type: 'text-start', id: 't' })
            c.enqueue({ type: 'text-delta', id: 't', delta: 'Half' })
            options.abortSignal?.addEventListener('abort', () => {
              aborted = true
              c.error(new DOMException('aborted', 'AbortError'))
            })
          },
        }),
    )
    fireEvent.change(composer(), { target: { value: 'Second question' } })
    fireEvent.keyDown(composer(), { key: 'Enter' })
    await waitFor(() => expect(screen.getAllByTestId('tutor-reply').at(-1)).toHaveTextContent('Half'))
    await open(B)
    await waitFor(() => expect(aborted).toBe(true))
    await idle()
    // The panel starts afresh for the new project; nothing was written to B's history.
    expect(screen.getByTestId('tutor-greeting')).toBeInTheDocument()
    await act(() => useTutorHistory.getState().flush())
    expect(backend.ai.history.get('proj-b')).toBeUndefined()
    expect(backend.ai.historySaves.every((s) => s.projectId === 'proj-a')).toBe(true)
  })

  it('C-M1: the first save of an untitled manuscript keeps the chat on screen and a reply still coming, and stores it under the new project', async () => {
    await renderApp()
    // Untitled: no project open (an earlier test may have left one).
    await act(() => closeProject())
    scripted([...text('First answer.'), finish('stop')])
    act(() => void runCommand(C.toggle.id))
    await focusComposer()
    fireEvent.change(composer(), { target: { value: 'First question' } })
    fireEvent.keyDown(composer(), { key: 'Enter' })
    await idle()
    // A second reply is streaming when the writer saves for the first time.
    let finishStream: () => void = () => {}
    scripted(
      () =>
        new ReadableStream<StreamPart>({
          start(c) {
            c.enqueue({ type: 'text-start', id: 't' })
            c.enqueue({ type: 'text-delta', id: 't', delta: 'Half ' })
            finishStream = () => {
              c.enqueue({ type: 'text-delta', id: 't', delta: 'and whole.' })
              c.enqueue({ type: 'text-end', id: 't' })
              c.enqueue(finish('stop'))
              c.close()
            }
          },
        }),
    )
    fireEvent.change(composer(), { target: { value: 'Second question' } })
    fireEvent.keyDown(composer(), { key: 'Enter' })
    await waitFor(() => expect(screen.getAllByTestId('tutor-reply').at(-1)).toHaveTextContent('Half'))
    const folder = '/books/new'
    backend.dirs.add(folder)
    backend.pick = folder
    const saved = await act(() => saveProject())
    expect(saved, JSON.stringify(backend.messages)).toBe(true)
    expect(useStore.getState().project.path).toBe(folder)
    // Still on screen, still streaming.
    expect(screen.getAllByTestId('tutor-user-message').map((m) => m.textContent)).toEqual([expect.stringContaining('First question'), expect.stringContaining('Second question')])
    act(() => finishStream())
    await idle()
    expect(screen.getAllByTestId('tutor-reply').at(-1)).toHaveTextContent('Half and whole.')
    await act(() => useTutorHistory.getState().flush())
    const projectId = JSON.parse(backend.files.get(`${folder}/project.json`)!).id as string
    const stored = [...(backend.ai.history.get(projectId)?.values() ?? [])]
    expect(stored.map((c) => c.title)).toEqual(['First question'])
    expect(JSON.stringify(stored[0].messages)).toContain('Half and whole.')
  })

  it('C1: opening another project mid-turn stops the tutor before its manuscript loads: no tool reads it, nothing of it is sent or saved under the old project', async () => {
    seed(A, 'proj-a', 'A')
    backend.dirs.add(B)
    const SECRET = 'Zanzibar marmalade'
    const docB = { type: 'doc', content: [{ type: 'heading', attrs: { level: 1 }, content: [t('Elsewhere')] }, { type: 'paragraph', content: [t(`${SECRET} on the quay.`)] }] }
    backend.files.set(`${B}/project.json`, JSON.stringify({ format: 'novel-project', schemaVersion: 1, id: 'proj-b', title: 'B', createdAt: 'a', updatedAt: 'b' }))
    backend.files.set(`${B}/manuscript.json`, JSON.stringify(docB))
    backend.recent = [...backend.recent, { path: B, name: 'B', openedAt: 'a' }]
    await renderApp()
    await open(A)
    // The first step calls read_range only once the editor holds another manuscript (the window between
    // the document swap and the project switch finishing); then the model would answer in a second step.
    let release: () => void = () => {}
    const unsub = useStore.subscribe((st, pr) => {
      if (st.editor.docVersion !== pr.editor.docVersion && getEditor()?.state.doc.textContent.includes(SECRET)) release()
    })
    const model = scripted(
      (options) =>
        new ReadableStream<StreamPart>({
          start(c) {
            c.enqueue({ type: 'text-start', id: 't' })
            c.enqueue({ type: 'text-delta', id: 't', delta: 'Let me read it. ' })
            c.enqueue({ type: 'text-end', id: 't' })
            release = () => {
              try {
                c.enqueue(call('read_range', { kind: 'attached' }))
                c.enqueue(finish('tool-calls'))
                c.close()
              } catch {
                // already aborted
              }
            }
            options.abortSignal?.addEventListener('abort', () => {
              try {
                c.error(new DOMException('aborted', 'AbortError'))
              } catch {
                // already closed
              }
            })
          },
        }),
      [...text('Here is what I read.'), finish('stop')],
    )
    act(() => void runCommand(C.toggle.id))
    await focusComposer()
    fireEvent.change(composer(), { target: { value: 'Read my chapter' } })
    fireEvent.keyDown(composer(), { key: 'Enter' })
    await waitFor(() => expect(screen.getAllByTestId('tutor-reply').at(-1)).toHaveTextContent('Let me read it.'))
    // A slow disk: the side files and the index take a while after the manuscript is in the editor.
    backend.readDelayMs = 30
    await open(B)
    backend.readDelayMs = 0
    await idle()
    await new Promise((r) => setTimeout(r, 20))
    unsub()
    expect(getEditor()!.state.doc.textContent).toContain(SECRET)
    // Nothing of project B went to the provider, and nothing was written to A's history.
    for (const callOptions of model.doStreamCalls) expect(JSON.stringify(callOptions.prompt)).not.toContain(SECRET)
    await act(() => useTutorHistory.getState().flush())
    for (const save of backend.ai.historySaves) expect(JSON.stringify(save.chat)).not.toContain(SECRET)
    expect(backend.ai.history.get('proj-b')).toBeUndefined()
  })

  it('M1: a change made just before another project opens is saved to the old project first', async () => {
    seed(A, 'proj-a', 'A')
    seed(B, 'proj-b', 'B')
    await renderApp()
    await open(A)
    scripted([...text('An answer.'), finish('stop')])
    act(() => void runCommand(C.toggle.id))
    await focusComposer()
    fireEvent.change(composer(), { target: { value: 'Quick question' } })
    fireEvent.keyDown(composer(), { key: 'Enter' })
    await idle()
    // Within the save debounce: nothing written yet.
    expect(backend.ai.historySaves).toHaveLength(0)
    await open(B)
    expect([...(backend.ai.history.get('proj-a')?.values() ?? [])].map((c) => c.title)).toEqual(['Quick question'])
  })

  it('⟲ lists the project chats; opening one brings it back (corrections can no longer be applied); delete removes it', async () => {
    seed(A, 'proj-a', 'A')
    await renderApp()
    await open(A)
    scripted(
      [call('list_corrections', { items: [{ paragraph: 'p2', kind: 'spelling', original: 'teh', suggestion: 'the', explanation: 'A typo.' }] }), finish('tool-calls')],
      [...text('One typo.'), finish('stop')],
    )
    act(() => void runCommand(C.toggle.id))
    fireEvent.click(await within(await openMenu(C.attach.id)).findByRole('menuitem', { name: /Current Page/ }))
    await focusComposer()
    fireEvent.change(composer(), { target: { value: 'Any typos?' } })
    fireEvent.keyDown(composer(), { key: 'Enter' })
    await idle()
    fireEvent.click(inPanel(C.newChat.id))
    await screen.findByTestId('tutor-greeting')
    fireEvent.click(inPanel(C.history.id))
    const list = await screen.findByTestId('tutor-history')
    const item = await within(list).findByRole('button', { name: /^Any typos\?/ })
    fireEvent.click(item)
    await waitFor(() => expect(screen.getAllByTestId('tutor-user-message')[0]).toHaveTextContent('Any typos?'))
    expect(screen.getAllByTestId('tutor-user-message')[0]).toHaveTextContent('Page 1')
    expect(screen.getAllByTestId('tutor-reply')[0]).toHaveTextContent('One typo.')
    const c = panel().querySelector<HTMLElement>('[data-correction-id]')!
    expect(c).toHaveAttribute('data-state', 'changed')
    // Honest about why (M5): the paragraph may be untouched; the earlier session's ids are gone.
    expect(c).toHaveTextContent('From an earlier session — ask again to refresh.')
    expect(c).not.toHaveTextContent('This paragraph changed')
    expect(c.querySelector(`[data-control-id="${C.correctionFix.id}"]`)).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(inPanel(C.history.id))
    const del = await within(await screen.findByTestId('tutor-history')).findByRole('button', { name: /Delete chat “Any typos\?”/ })
    // It asks first (final C-M7): Cancel keeps the chat.
    backend.answer = 'Cancel'
    fireEvent.click(del)
    await waitFor(() => expect(backend.messages.at(-1)?.text).toBe('Delete the chat “Any typos?”? It is removed from this computer and cannot be undone.'))
    await act(() => new Promise((r) => setTimeout(r, 20)))
    expect(backend.ai.history.get('proj-a')?.size).toBe(1)
    backend.answer = 'Delete'
    fireEvent.click(del)
    await waitFor(() => expect(screen.getByTestId('tutor-history')).toHaveTextContent('No chats yet for this project.'))
    expect(backend.ai.history.get('proj-a')?.size ?? 0).toBe(0)
  })

  /** Turn one in A: Current Page attached (p1–p3), one correction on p2; then New Chat and reopen it. */
  async function reopenCorrectionChat() {
    seed(A, 'proj-a', 'A')
    await renderApp()
    await open(A)
    scripted(
      [call('list_corrections', { items: [{ paragraph: 'p2', kind: 'spelling', original: 'teh', suggestion: 'the', explanation: 'A typo.' }] }), finish('tool-calls')],
      [...text('One typo.'), finish('stop')],
    )
    act(() => void runCommand(C.toggle.id))
    fireEvent.click(await within(await openMenu(C.attach.id)).findByRole('menuitem', { name: /Current Page/ }))
    await focusComposer()
    fireEvent.change(composer(), { target: { value: 'Any typos?' } })
    fireEvent.keyDown(composer(), { key: 'Enter' })
    await idle()
    fireEvent.click(inPanel(C.newChat.id))
    await screen.findByTestId('tutor-greeting')
    fireEvent.click(inPanel(C.history.id))
    fireEvent.click(await within(await screen.findByTestId('tutor-history')).findByRole('button', { name: /^Any typos\?/ }))
    await waitFor(() => expect(screen.getAllByTestId('tutor-reply')[0]).toHaveTextContent('One typo.'))
  }

  it("B-I2: a reopened chat's old paragraph ids are unknown to the new session: a correction naming one is rejected and the model is told to re-read", async () => {
    await reopenCorrectionChat()
    const model = scripted(
      [call('list_corrections', { items: [{ paragraph: 'p2', kind: 'spelling', original: 'teh', suggestion: 'the', explanation: 'Apply it.' }] }), finish('tool-calls')],
      [...text('I need to read it again.'), finish('stop')],
    )
    await focusComposer()
    fireEvent.change(composer(), { target: { value: 'Apply the fix you found' } })
    fireEvent.keyDown(composer(), { key: 'Enter' })
    await idle()
    const second = JSON.stringify(model.doStreamCalls[1].prompt)
    expect(second).toContain('unknown_paragraph')
    // No new correction was listed; the one from the history still cannot be applied.
    const listed = panel().querySelectorAll('[data-correction-id]')
    expect(listed).toHaveLength(1)
    expect(listed[0]).toHaveAttribute('data-state', 'changed')
    // The new session mints above the chat's ids: the paragraph is p4 or later now.
    const s = (await import('@/features/ai-tutor/panel/chat')).getTutorSession()!
    expect(s.idx.idFor(blockPos(1))).toBe('p4')
  })
})
