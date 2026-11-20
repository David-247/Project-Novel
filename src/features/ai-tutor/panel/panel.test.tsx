import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { TextSelection } from '@tiptap/pm/state'
import { APICallError } from 'ai'
import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test'
import { flushWordCount, getEditor, NovelEditor, setDocJSON, type JSONContent } from '@/features/editor'
import { closeRewrite, openRewriteWithVersion } from '@/features/rewrite'
import { useStore, type PageInfo } from '@/shared/store'
import { TooltipProvider } from '@/shared/ui'
import { backend } from '@/test-utils/fake-tauri'

vi.mock('@tauri-apps/api/core', async () => (await import('@/test-utils/fake-tauri')).coreModule)
vi.mock('@tauri-apps/plugin-dialog', async () => (await import('@/test-utils/fake-tauri')).dialogModule)

/**
 * The tutor panel's component tests (Task 9): the fake provider is the AI SDK's mock model (`ai/test`)
 * behind a test adapter, so no request ever reaches the fake core's `ai_fetch` (asserted as well).
 */
const hoisted = vi.hoisted(() => ({
  model: null as unknown,
  models: [] as { id: string; label: string; tools: 'yes' | 'no' | 'unknown' }[],
  listCalls: 0,
}))
vi.mock('../providers/registry', () => ({
  getAdapter: () => ({
    label: 'Test provider',
    languageModel: () => hoisted.model,
    listModels: async () => {
      hoisted.listCalls++
      return hoisted.models
    },
  }),
  listAdapters: () => [],
  modelSupportsTools: (c: { toolSupport?: Record<string, boolean> }, m: { id: string; tools: string }) => c.toolSupport?.[m.id] ?? m.tools === 'yes',
}))

import { closeTutor, openTutor, __resetTutorPanelForTests, tutorMenuItems } from '../commands'
import { useTutorHistory } from '../history/store'
import { __resetTutorChatForTests, getTutorSession, projectChanged, send as sendNow, stop, useTutorChat } from './chat'
import { NO_TOOLS_REASON, TUTOR_CONTROLS as C } from './controls'
import { setTutorConnectAction } from './connect'
import { TutorPanel } from './TutorPanel'

type CallOptions = Parameters<MockLanguageModelV4['doStream']>[0]
type StreamPart = Awaited<ReturnType<MockLanguageModelV4['doStream']>>['stream'] extends ReadableStream<infer P> ? P : never

beforeAll(() => {
  const rect = { x: 0, y: 0, top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0, toJSON: () => ({}) }
  const emptyRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList
  Range.prototype.getClientRects ??= emptyRects
  Range.prototype.getBoundingClientRect ??= () => rect as DOMRect
  Element.prototype.getClientRects ??= emptyRects
  document.elementFromPoint ??= () => null
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})

const CONNECTION = { id: 'conn-1', provider: 'openai', label: 'OpenAI', auth: 'api_key' as const, defaultModel: 'gpt-test' }

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
      const stream = typeof step === 'function' ? await step(options) : convertArrayToReadableStream(step)
      return { stream }
    },
  })
  hoisted.model = model
  return model
}

const para = (t: string): JSONContent => ({ type: 'paragraph', content: [{ type: 'text', text: t }] })
const h1 = (t: string): JSONContent => ({ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: t }] })
const DOC: JSONContent[] = [h1('One'), para('I saw teh dog.'), para('It ran acros the road.'), h1('Two'), para('Far away.')]

const page = (index: number, from: number, to: number, chapterIndex: number): PageInfo => ({
  index,
  side: index % 2 === 0 ? 'recto' : 'verso',
  from,
  to,
  isBlank: false,
  startsBlockType: null,
  chapterIndex,
})

function blockPos(i: number): number {
  const doc = getEditor()!.state.doc
  let pos = 0
  for (let k = 0; k < i; k++) pos += doc.child(k).nodeSize
  return pos
}

async function mount(content: JSONContent[] = DOC, { connected = true } = {}) {
  render(
    <TooltipProvider>
      <NovelEditor />
      <TutorPanel />
    </TooltipProvider>,
  )
  await waitFor(() => expect(getEditor()).not.toBeNull())
  act(() => setDocJSON({ type: 'doc', content }))
  act(() => flushWordCount())
  const ed = getEditor()!
  const end = ed.state.doc.content.size
  const two = ed.state.doc.childCount > 3 ? blockPos(3) : end
  act(() => {
    useStore.getState().layoutActions.setPages(two < end ? [page(0, 0, two, 0), page(1, two, end, 1)] : [page(0, 0, end, -1)])
    useStore.getState().layoutActions.setCurrentPage(0)
    useStore.getState().tutorConnectionsActions.setConnections(connected ? [CONNECTION] : [], connected ? CONNECTION.id : null)
  })
  act(() => openTutor())
  return ed
}

const panel = () => screen.getByTestId('tutor-panel')
const ctl = (id: string) => panel().querySelector<HTMLElement>(`[data-control-id="${id}"]`)!
const composer = () => ctl(C.composer.id) as HTMLTextAreaElement
const type = (value: string) => fireEvent.change(composer(), { target: { value } })
const press = (key: string, opts: Partial<KeyboardEventInit> = {}) => fireEvent.keyDown(composer(), { key, ...opts })
const replies = () => screen.queryAllByTestId('tutor-reply')
const lastReply = () => replies().at(-1)!
const idle = () => waitFor(() => expect(useTutorChat.getState().busy).toBe(false))

/** Open the + menu with the keyboard (as a writer would) and choose `name`. */
async function attachFromMenu(name: RegExp) {
  // The composer takes the focus a frame after the panel opens or a menu closes (a menu open then would close).
  await waitFor(() => expect(document.activeElement).toBe(composer()))
  fireEvent.keyDown(ctl(C.attach.id), { key: 'Enter' })
  const item = await screen.findByRole('menuitem', { name })
  fireEvent.click(item)
}

beforeEach(() => {
  backend.reset()
  __resetTutorChatForTests()
  __resetTutorPanelForTests()
  useTutorHistory.setState({ chat: null, chats: [], projectId: null, error: null })
  useStore.getState().rewriteActions.loaded([])
  hoisted.models = [{ id: 'gpt-test', label: 'GPT Test', tools: 'yes' }]
  hoisted.listCalls = 0
  hoisted.model = null
})
afterEach(() => {
  act(() => closeRewrite())
  act(() => closeTutor())
  cleanup()
  useStore.getState().layoutActions.resetLayout()
})

describe('opening and the greeting', () => {
  it('shows the greeting and three suggested prompts, with the composer focused', async () => {
    await mount()
    expect(screen.getByTestId('tutor-greeting')).toHaveTextContent("Hi, I'm ready to help with all your writing needs.")
    const prompts = within(screen.getByRole('list', { name: 'Suggested prompts' })).getAllByRole('button')
    expect(prompts.map((b) => b.textContent)).toEqual(['What can you do?', 'Help me format my chapter', 'Check my grammar'])
    await waitFor(() => expect(document.activeElement).toBe(composer()))
    expect(screen.getByText(/Using:/)).toHaveTextContent('Using: OpenAI · gpt-test')
  })

  it('nothing reaches ai_fetch until send: opening, attaching from the + menu and typing make no request', async () => {
    const model = scripted([...text('Hello.'), finish('stop')])
    await mount()
    await attachFromMenu(/Current Page/)
    await attachFromMenu(/Whole Manuscript/)
    type('Is there a mistake here?')
    expect(screen.getAllByTestId('tutor-chip').map((c) => c.textContent)).toEqual([expect.stringContaining('Page 1'), expect.stringContaining('Whole manuscript')])
    expect(model.doStreamCalls).toHaveLength(0)
    expect(backend.ai.requests).toHaveLength(0)
    expect(hoisted.listCalls).toBe(0)
  })

  it('"What can you do?" shows the capabilities without any call', async () => {
    const model = scripted([...text('x'), finish('stop')])
    await mount()
    fireEvent.click(screen.getByRole('button', { name: 'What can you do?' }))
    expect(lastReply()).toHaveTextContent("I'm your editor and writing teacher.")
    expect(lastReply()).toHaveTextContent("One thing I won't do is write your story for you.")
    expect(model.doStreamCalls).toHaveLength(0)
    expect(backend.ai.requests).toHaveLength(0)
  })

  it('"Check my grammar" sends the current page with the proofread script; "Help me format my chapter" the chapter with format', async () => {
    const model = scripted([...text('Looks fine.'), finish('stop')], [...text('Formatted.'), finish('stop')])
    await mount()
    act(() => getEditor()!.commands.setTextSelection(blockPos(1) + 2))
    fireEvent.click(screen.getByRole('button', { name: 'Check my grammar' }))
    await idle()
    const first = model.doStreamCalls[0]
    const system = first.prompt.filter((m) => m.role === 'system').map((m) => m.content as string).join('\n')
    expect(system).toMatch(/proofread/i)
    expect(JSON.stringify(first.prompt)).toContain('<manuscript source=\\"Page 1\\">')
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }))
    await waitFor(() => expect(screen.getByTestId('tutor-greeting')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Help me format my chapter' }))
    await idle()
    expect(JSON.stringify(model.doStreamCalls[1].prompt)).toContain('<manuscript source=\\"Chapter 1: One\\">')
  })
})

describe('the composer', () => {
  it('Enter sends, Shift+Enter does not; chips are removed with ✕ or Backspace in an empty box', async () => {
    const model = scripted([...text('Hi there.'), finish('stop')])
    await mount()
    await attachFromMenu(/Current Page/)
    await attachFromMenu(/Whole Manuscript/)
    expect(screen.getAllByTestId('tutor-chip')).toHaveLength(2)
    press('Backspace')
    expect(screen.getAllByTestId('tutor-chip')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Remove Page 1' }))
    expect(screen.queryAllByTestId('tutor-chip')).toHaveLength(0)
    type('Hello')
    press('Enter', { shiftKey: true })
    expect(model.doStreamCalls).toHaveLength(0)
    press('Enter')
    await idle()
    expect(model.doStreamCalls).toHaveLength(1)
    expect(lastReply()).toHaveTextContent('Hi there.')
    expect(composer().value).toBe('')
  })

  it('Selection is off with a caret; a selection chip follows the edits before it', async () => {
    const ed = await mount()
    await waitFor(() => expect(document.activeElement).toBe(composer()))
    fireEvent.keyDown(ctl(C.attach.id), { key: 'Enter' })
    expect(await screen.findByRole('menuitem', { name: /Selection/ })).toHaveAttribute('data-disabled')
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    const at = blockPos(2) + 1
    act(() => ed.view.dispatch(ed.state.tr.setSelection(TextSelection.create(ed.state.doc, at, at + 6))))
    await attachFromMenu(/Selection/)
    const before = useTutorChat.getState().chips[0].attachment
    expect(before).toEqual({ kind: 'selection', from: at, to: at + 6 })
    act(() => ed.view.dispatch(ed.state.tr.insertText('Well, ', blockPos(1) + 1)))
    expect(useTutorChat.getState().chips[0].attachment).toEqual({ kind: 'selection', from: at + 6, to: at + 12 })
  })

  it('asks first above 20,000 words (at 20,001), not at 20,000; Cancel sends nothing', async () => {
    const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ')
    const model = scripted([...text('Read it.'), finish('stop')])
    const ed = await mount([para(words(20_000))])
    const select = () => act(() => ed.view.dispatch(ed.state.tr.setSelection(TextSelection.create(ed.state.doc, 1, ed.state.doc.content.size - 1))))
    select()
    await attachFromMenu(/Selection/)
    type('Check this.')
    press('Enter')
    await idle()
    expect(backend.messages).toEqual([])
    expect(model.doStreamCalls).toHaveLength(1)

    // A new chat: only this message's attachment counts (a follow-up would carry the first 20,000 words too).
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }))
    await waitFor(() => expect(useTutorChat.getState().messages).toHaveLength(0))
    act(() => ed.view.dispatch(ed.state.tr.insertText(' extra', ed.state.doc.content.size - 1)))
    select()
    await attachFromMenu(/Selection/)
    backend.answer = 'Cancel'
    type('And now?')
    press('Enter')
    await waitFor(() => expect(backend.messages).toHaveLength(1))
    expect(backend.messages[0].text).toBe('Send about 20,001 words to OpenAI?')
    await idle()
    expect(model.doStreamCalls).toHaveLength(1)
    expect(composer().value).toBe('And now?')
  })

  it('Whole Manuscript always asks, whatever its size', async () => {
    scripted([...text('Read it.'), finish('stop')])
    await mount()
    await attachFromMenu(/Whole Manuscript/)
    backend.answer = 'Send'
    type('Look at all of it.')
    press('Enter')
    await idle()
    expect(backend.messages.map((m) => m.text)).toEqual([expect.stringMatching(/^Send about \d+ words to OpenAI\?$/)])
    expect(lastReply()).toHaveTextContent('Read it.')
  })
})

/** Turn one: the model lists two corrections (one per paragraph), then explains. */
async function correctionTurn(before?: () => void) {
  const model = scripted(
    [
      call('list_corrections', {
        items: [
          // Ids are minted for the attached paragraphs in order, the chapter title first (p1).
          { paragraph: 'p2', kind: 'spelling', original: 'teh', suggestion: 'the', explanation: 'A typo for "the".' },
          { paragraph: 'p3', kind: 'spelling', original: 'acros', suggestion: 'across', explanation: 'Across has a double s.' },
        ],
      }),
      finish('tool-calls'),
    ],
    [...text('I found two typos.'), finish('stop')],
  )
  const ed = await mount()
  before?.()
  await attachFromMenu(/Current Page/)
  type('Any mistakes?')
  press('Enter')
  await idle()
  return { ed, model }
}

const items = () => screen.getAllByRole('listitem').filter((li) => li.hasAttribute('data-correction-id'))
const btn = (li: HTMLElement, id: string) => li.querySelector<HTMLElement>(`[data-control-id="${id}"]`)!

describe('corrections', () => {
  it('lists the corrections with their location; jump selects the text, Fix applies it, Ignore sets it aside', async () => {
    const { ed } = await correctionTurn()
    expect(lastReply()).toHaveTextContent('I found two typos.')
    const [a, b] = items()
    expect(btn(a, C.correctionJump.id)).toHaveTextContent('Ch 1 ¶1')
    expect(btn(b, C.correctionJump.id)).toHaveTextContent('Ch 1 ¶2')
    fireEvent.click(btn(a, C.correctionJump.id))
    const sel = ed.state.selection
    expect(ed.state.doc.textBetween(sel.from, sel.to)).toBe('teh')
    fireEvent.click(btn(a, C.correctionFix.id))
    expect(ed.state.doc.child(1).textContent).toBe('I saw the dog.')
    expect(items()[0]).toHaveAttribute('data-state', 'applied')
    expect(items()[0]).toHaveTextContent('Fixed')
    fireEvent.click(btn(items()[1], C.correctionIgnore.id))
    expect(items()[1]).toHaveAttribute('data-state', 'ignored')
    expect(ed.state.doc.child(2).textContent).toBe('It ran acros the road.')
  })

  it("Fix is off with the reason once the writer edits the paragraph ('changed'); never applied elsewhere", async () => {
    const { ed } = await correctionTurn()
    act(() => ed.view.dispatch(ed.state.tr.insertText('Then ', blockPos(1) + 1)))
    const a = items()[0]
    expect(a).toHaveAttribute('data-state', 'changed')
    expect(a).toHaveTextContent('This paragraph changed; ask again to refresh.')
    const fix = btn(a, C.correctionFix.id)
    expect(fix).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(fix)
    expect(ed.state.doc.child(1).textContent).toBe('Then I saw teh dog.')
    // The other paragraph was not touched: its Fix still works.
    fireEvent.click(btn(items()[1], C.correctionFix.id))
    expect(ed.state.doc.child(2).textContent).toBe('It ran across the road.')
  })

  it('Fix is off inside a locked re-write passage, with the reason in its tooltip', async () => {
    // The passage is in re-write (its view closed) before the tutor lists the correction there.
    const { ed } = await correctionTurn(() => {
      act(() => void openRewriteWithVersion({ from: blockPos(1) + 1, to: blockPos(1) + 2 }, () => true))
      act(() => closeRewrite())
    })
    const a = items()[0]
    expect(a).toHaveTextContent('This passage is in re-write, so change it in the re-write view.')
    const fix = btn(a, C.correctionFix.id)
    expect(fix).toHaveAttribute('aria-disabled', 'true')
    expect(fix.getAttribute('aria-describedby')).toBeTruthy()
    expect(document.getElementById(fix.getAttribute('aria-describedby')!)).toHaveTextContent('Not now: This passage is in re-write')
    fireEvent.click(fix)
    expect(ed.state.doc.child(1).textContent).toBe('I saw teh dog.')
  })

  it('is saved with the reply in the chat history, with its state', async () => {
    await correctionTurn()
    fireEvent.click(btn(items()[0], C.correctionFix.id))
    const stored = useTutorHistory.getState().chat!.messages
    expect(stored.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
    expect(stored[0].attachments).toEqual([{ label: 'Page 1', text: expect.stringContaining('[p2] I saw teh dog.') }])
    expect(stored[3].corrections?.map((c) => c.state)).toEqual(['applied', 'open'])
  })
})

describe('proposals and read requests', () => {
  it('a proposal opens the re-write view on the "Tutor suggestion" version', async () => {
    scripted(
      [call('propose_change', { paragraphIds: ['p2'], revisedText: ['I saw the dog.'], reason: 'One typo.' }), finish('tool-calls')],
      [...text('Compare it side by side.'), finish('stop')],
    )
    await mount()
    await attachFromMenu(/Current Page/)
    type('Fix it')
    press('Enter')
    await idle()
    expect(screen.getByTestId('tutor-proposal')).toHaveTextContent('One typo.')
    fireEvent.click(screen.getByRole('button', { name: /Compare Side by Side/ }))
    const r = useStore.getState().rewrite
    expect(r.openId).not.toBeNull()
    const record = r.rewrites.find((x) => x.id === r.openId)!
    const version = record.versions.find((v) => v.id === r.activeVersionId)!
    expect(version.name).toBe('Tutor suggestion')
    expect(JSON.stringify(version.doc)).toContain('I saw the dog.')
    expect(getEditor()!.state.doc.child(1).textContent).toBe('I saw teh dog.')
    expect(screen.getByTestId('tutor-proposal')).toHaveTextContent('Open in the re-write view')
  })

  it('a proposal across chapters is not opened: it says why', async () => {
    scripted(
      [call('propose_change', { paragraphIds: ['p3', 'p5'], revisedText: ['It ran across the road.', 'Far away!'], reason: 'Typos.' }), finish('tool-calls')],
      [...text('Here.'), finish('stop')],
    )
    await mount()
    await attachFromMenu(/Whole Manuscript/)
    backend.answer = 'Send'
    type('Fix it')
    press('Enter')
    await idle()
    fireEvent.click(screen.getByRole('button', { name: /Compare Side by Side/ }))
    expect(useStore.getState().rewrite.openId).toBeNull()
    expect(screen.getByTestId('tutor-proposal')).toHaveTextContent("covers more than one chapter")
  })

  it('a read request asks inline; Allow lets the tool read', async () => {
    const model = scripted([call('read_range', { kind: 'chapter', number: 2 }), finish('tool-calls')], [...text('Chapter 2 is short.'), finish('stop')])
    await mount()
    await attachFromMenu(/Current Page/)
    type('And the next chapter?')
    press('Enter')
    const req = await screen.findByTestId('tutor-read-request')
    expect(req).toHaveTextContent('The tutor wants to read Chapter 2: Two. Allow?')
    fireEvent.click(within(req).getByRole('button', { name: 'Allow' }))
    await idle()
    expect(req).toHaveTextContent('Allowed for this question.')
    expect(JSON.stringify(model.doStreamCalls[1].prompt)).toContain('Far away.')
  })

  it("Don't Allow keeps the text from the tutor", async () => {
    const model = scripted([call('read_range', { kind: 'chapter', number: 2 }), finish('tool-calls')], [...text('Fine.'), finish('stop')])
    await mount()
    await attachFromMenu(/Current Page/)
    type('And the next chapter?')
    press('Enter')
    const req = await screen.findByTestId('tutor-read-request')
    fireEvent.click(within(req).getByRole('button', { name: "Don't Allow" }))
    await idle()
    expect(JSON.stringify(model.doStreamCalls[1].prompt)).not.toContain('Far away.')
    expect(JSON.stringify(model.doStreamCalls[1].prompt)).toContain('denied')
  })
})

describe('fix round 1', () => {
  const rateLimited = () =>
    Promise.reject(new APICallError({ message: 'Too Many Requests', url: 'https://provider.invalid/chat', requestBodyValues: {}, statusCode: 429, isRetryable: true }))

  it('I1: a follow-up that re-sends an earlier Whole manuscript attachment asks again', async () => {
    scripted([...text('Read it.'), finish('stop')], [...text('Chapter 2 is fine.'), finish('stop')])
    await mount()
    await attachFromMenu(/Whole Manuscript/)
    backend.answer = 'Send'
    type('Look at all of it.')
    press('Enter')
    await idle()
    expect(backend.messages).toHaveLength(1)
    // No chips now, but the chat carries the whole book: it is sent again, so it asks again.
    backend.answer = 'Cancel'
    type('And chapter 2?')
    press('Enter')
    await waitFor(() => expect(backend.messages).toHaveLength(2))
    expect(backend.messages[1].text).toMatch(/^Send about \d+ words to OpenAI\?$/)
    await idle()
    expect(composer().value).toBe('And chapter 2?')
  })

  it('I1: a follow-up whose earlier attachments plus the new ones pass 20,000 words asks', async () => {
    const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ')
    scripted([...text('One.'), finish('stop')], [...text('Two.'), finish('stop')])
    const ed = await mount([para(words(12_000)), para(words(9_000))])
    act(() => ed.view.dispatch(ed.state.tr.setSelection(TextSelection.create(ed.state.doc, 1, ed.state.doc.child(0).nodeSize - 1))))
    await attachFromMenu(/Selection/)
    type('First')
    press('Enter')
    await idle()
    expect(backend.messages).toHaveLength(0)
    const second = ed.state.doc.child(0).nodeSize
    act(() => ed.view.dispatch(ed.state.tr.setSelection(TextSelection.create(ed.state.doc, second + 1, ed.state.doc.content.size - 1))))
    await attachFromMenu(/Selection/)
    backend.answer = 'Cancel'
    type('Second')
    press('Enter')
    await waitFor(() => expect(backend.messages).toHaveLength(1))
    expect(backend.messages[0].text).toBe('Send about 21,000 words to OpenAI?')
  })

  it('I1: Retry of a Whole manuscript send asks again; Cancel sends nothing', async () => {
    const model = scripted(rateLimited, [...text('Now.'), finish('stop')])
    await mount()
    await attachFromMenu(/Whole Manuscript/)
    backend.answer = 'Send'
    type('All of it')
    press('Enter')
    await idle()
    expect(screen.getByTestId('tutor-error')).toBeInTheDocument()
    backend.answer = 'Cancel'
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(backend.messages).toHaveLength(2))
    await idle()
    expect(model.doStreamCalls).toHaveLength(1)
    backend.answer = 'Send'
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await idle()
    expect(model.doStreamCalls).toHaveLength(2)
    expect(lastReply()).toHaveTextContent('Now.')
  })

  it('I2: Retry works when the connection has no default model (the model was picked at send)', async () => {
    const model = scripted(rateLimited, [...text('Second try.'), finish('stop')])
    await mount()
    act(() => useStore.getState().tutorConnectionsActions.setConnections([{ ...CONNECTION, defaultModel: undefined }], CONNECTION.id))
    type('Hello?')
    press('Enter')
    await idle()
    expect(hoisted.listCalls).toBe(1)
    expect(model.doStreamCalls).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await idle()
    expect(model.doStreamCalls).toHaveLength(2)
    expect(model.doStreamCalls[1].prompt.filter((m) => m.role === 'user')).toHaveLength(1)
    expect(lastReply()).toHaveTextContent('Second try.')
  })

  it("M3: Retry sends the selection where it is now, after edits before it", async () => {
    const model = scripted(rateLimited, [...text('OK.'), finish('stop')])
    const ed = await mount()
    const at = blockPos(2) + 1
    act(() => ed.view.dispatch(ed.state.tr.setSelection(TextSelection.create(ed.state.doc, at, at + 'It ran acros'.length))))
    await attachFromMenu(/Selection/)
    type('Spelling?')
    press('Enter')
    await idle()
    act(() => ed.view.dispatch(ed.state.tr.insertText('Suddenly ', blockPos(1) + 1)))
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await idle()
    const sent = JSON.stringify(model.doStreamCalls[1].prompt)
    expect(sent).toContain('It ran acros')
    expect(sent).not.toContain('Suddenly')
  })

  it("M2: an aborted turn finishing late does not let stop() return before the newer turn is done", async () => {
    const pending = () => (options: CallOptions) =>
      new ReadableStream<StreamPart>({
        start(c) {
          c.enqueue({ type: 'text-start', id: 't' })
          c.enqueue({ type: 'text-delta', id: 't', delta: 'streaming' })
          options.abortSignal?.addEventListener('abort', () => c.error(new DOMException('aborted', 'AbortError')))
        },
      })
    scripted(pending(), pending())
    await mount()
    type('A')
    press('Enter')
    await waitFor(() => expect(lastReply()).toHaveTextContent('streaming'))
    // A project switch aborts A; B is sent before A has unwound, so A's turn finishes after B started.
    let b!: Promise<void>
    act(() => {
      projectChanged()
      b = sendNow({ text: 'B' })
    })
    await waitFor(() => expect(lastReply()).toHaveTextContent('streaming'))
    await act(async () => {
      await stop()
      // stop() resolves only once B's turn has finished.
      expect(useTutorChat.getState().busy).toBe(false)
    })
    await b
  })
})

describe('streaming, Stop, errors', () => {
  it('Stop replaces ➤ while a reply streams and aborts it; the partial reply stays, marked incomplete', async () => {
    let aborted = false
    scripted((options) => {
      return new ReadableStream<StreamPart>({
        start(c) {
          c.enqueue({ type: 'text-start', id: 't' })
          c.enqueue({ type: 'text-delta', id: 't', delta: 'The first half' })
          options.abortSignal?.addEventListener('abort', () => {
            aborted = true
            c.error(new DOMException('aborted', 'AbortError'))
          })
        },
      })
    })
    await mount()
    type('Talk')
    press('Enter')
    await waitFor(() => expect(lastReply()).toHaveTextContent('The first half'))
    expect(ctl(C.send.id)).toBeNull()
    fireEvent.click(ctl(C.stop.id))
    await idle()
    expect(aborted).toBe(true)
    expect(ctl(C.send.id)).not.toBeNull()
    expect(lastReply()).toHaveTextContent('The first half')
    expect(screen.getByTestId('tutor-incomplete')).toHaveTextContent('Stopped. This reply is incomplete.')
  })

  it('a 429 shows a human message and Retry; Retry asks again and answers', async () => {
    const model = scripted(
      () => Promise.reject(new APICallError({ message: 'Too Many Requests', url: 'https://provider.invalid/chat', requestBodyValues: {}, statusCode: 429, isRetryable: true })),
      [...text('Now it works.'), finish('stop')],
    )
    await mount()
    type('Hello?')
    press('Enter')
    await idle()
    expect(screen.getByTestId('tutor-error')).toHaveTextContent('The provider is limiting requests. Wait a moment and try again.')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await idle()
    expect(model.doStreamCalls).toHaveLength(2)
    // The same question, without the failed turn.
    expect(model.doStreamCalls[1].prompt.filter((m) => m.role === 'user')).toHaveLength(1)
    expect(lastReply()).toHaveTextContent('Now it works.')
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
  })

  it('closing the panel mid-stream aborts the reply', async () => {
    let aborted = false
    scripted(
      (options) =>
        new ReadableStream<StreamPart>({
          start(c) {
            c.enqueue({ type: 'text-start', id: 't' })
            options.abortSignal?.addEventListener('abort', () => {
              aborted = true
              c.error(new DOMException('aborted', 'AbortError'))
            })
          },
        }),
    )
    await mount()
    type('Talk')
    press('Enter')
    await waitFor(() => expect(useTutorChat.getState().busy).toBe(true))
    act(() => closeTutor())
    await waitFor(() => expect(aborted).toBe(true))
    expect(screen.queryByTestId('tutor-panel')).toBeNull()
  })
})

describe('connection and model', () => {
  it('not connected: the scripted reply with "Connect a Provider…", no call', async () => {
    const connect = vi.fn()
    setTutorConnectAction(connect)
    const model = scripted([...text('x'), finish('stop')])
    await mount(DOC, { connected: false })
    expect(screen.getByText(/Using:/)).toHaveTextContent('Using: Not connected')
    type('Hello')
    press('Enter')
    expect(lastReply()).toHaveTextContent("I'm not connected to an AI provider yet.")
    fireEvent.click(within(lastReply()).getByRole('button', { name: 'Connect a Provider…' }))
    expect(connect).toHaveBeenCalledOnce()
    expect(model.doStreamCalls).toHaveLength(0)
    setTutorConnectAction(null)
  })

  it('the picker lists the models when opened; one without tools is listed but off, with the reason', async () => {
    hoisted.models = [
      { id: 'gpt-test', label: 'GPT Test', tools: 'yes' },
      { id: 'tiny', label: 'Tiny', tools: 'unknown' },
    ]
    await mount()
    expect(hoisted.listCalls).toBe(0)
    await waitFor(() => expect(document.activeElement).toBe(composer()))
    fireEvent.keyDown(ctl(C.model.id), { key: 'Enter' })
    const tiny = await screen.findByRole('menuitem', { name: /Tiny/ })
    expect(hoisted.listCalls).toBe(1)
    expect(tiny).toHaveAttribute('aria-disabled', 'true')
    expect(tiny).toHaveTextContent("Can't use tools")
    expect(document.getElementById(tiny.getAttribute('aria-describedby')!)).toHaveTextContent(NO_TOOLS_REASON)
    fireEvent.click(tiny)
    expect(useTutorChat.getState().modelId).toBeNull()
    fireEvent.click(await screen.findByRole('menuitem', { name: /GPT Test/ }))
    expect(useTutorChat.getState().modelId).toBe('gpt-test')
  })
})

describe('chat history', () => {
  it('⟲ lists the chats; one opens again; New Chat starts fresh', async () => {
    backend.ai.history.clear()
    scripted([...text('First answer.'), finish('stop')])
    await mount()
    type('First question')
    press('Enter')
    await idle()
    const chatId = useTutorChat.getState().chatId!
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }))
    await waitFor(() => expect(screen.getByTestId('tutor-greeting')).toBeInTheDocument())
    // Without a project the chat lives in memory; the list is empty and says why.
    fireEvent.click(screen.getByRole('button', { name: 'Chat history' }))
    expect(await screen.findByTestId('tutor-history')).toHaveTextContent('Open a project to keep its chats.')
    expect(chatId).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Back to chat' }))
    expect(screen.getByTestId('tutor-greeting')).toBeInTheDocument()
  })
})

describe('"Ask the Tutor About This"', () => {
  it('attaches the selection, or the paragraph at the menu, and opens the panel on the composer', async () => {
    const ed = await mount()
    act(() => closeTutor())
    const at = blockPos(1) + 3
    const [item] = tutorMenuItems({ editor: ed, pos: at, selection: ed.state.selection })
    expect(item.label).toBe('Ask the Tutor About This')
    act(() => item.run())
    expect(screen.getByTestId('tutor-panel')).toBeInTheDocument()
    expect(useTutorChat.getState().chips.map((c) => [c.label, c.attachment])).toEqual([['Paragraph', { kind: 'selection', from: blockPos(1) + 1, to: blockPos(2) - 1 }]])
    await waitFor(() => expect(document.activeElement).toBe(composer()))
    expect(getTutorSession()).not.toBeNull()
  })
})
