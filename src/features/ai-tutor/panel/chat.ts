import type { Transaction } from '@tiptap/pm/state'
import type { ModelMessage } from 'ai'
import { create } from 'zustand'
import { countRange, getChapters, chapterIndexAt, getEditor, type Editor } from '@/features/editor'
import { askConfirm } from '@/features/storage'
import { useStore } from '@/shared/store'
import { countText } from '@/shared/text'
import { USER_HOSTED_PROVIDERS, type Connection } from '../connections/types'
import { scriptedReply, type ScriptName } from '../harness/assemble'
import { attachmentLabel, attachmentText, type Attachment } from '../harness/attachments'
import type { Correction, ProposedChange } from '../harness/output-tools'
import { createTutorSession, runTutorTurn, type TurnEvent, type TutorSession } from '../harness/run-turn'
import { useTutorHistory } from '../history/store'
import type { StoredMessage } from '../history/types'
import { getAdapter, modelSupportsTools } from '../providers/registry'
import type { ModelInfo } from '../providers/types'
import { applyCorrection, fixAvailability, jumpToCorrection, openProposal } from './apply'
import { CONFIRM_WORDS, NO_TOOLS_REASON } from './controls'

/**
 * The tutor panel's chat: what it shows (the `useTutorChat` store) and what it does (the functions
 * below). One chat at a time, with one TutorSession (paragraph ids and corrections that follow the
 * editor). Nothing reaches `ai_fetch` before the writer sends: opening the panel, attaching and typing
 * make no request (Global Constraints), and neither does "What can you do?" (a scripted reply).
 *
 * A chat is stored through useTutorHistory (app data, keyed by the project's meta.id) after each turn:
 * the messages as sent (attached text included), the corrections on the reply. Closing the panel,
 * starting a new chat, opening another one or another project stops a reply that is still coming
 * first (Review Focus 5).
 */

// ---- What the panel shows ------------------------------------------------------------------------

export interface Chip {
  id: string
  attachment: Attachment
  /** "Page 41", "Chapter 3: The Storm", "Selection", "Paragraph", "Whole manuscript". */
  label: string
  words: number
}

export interface ProposalView {
  id: string
  change: ProposedChange
  /** Opened in the re-write view, or why it could not be. */
  status: 'ready' | 'opened' | 'blocked'
  note: string | null
}

export interface ReadView {
  id: string
  target: string
  answer: 'pending' | 'allowed' | 'denied'
}

export type ReplyPart =
  | { kind: 'text'; text: string }
  | { kind: 'corrections'; items: Correction[] }
  | { kind: 'proposal'; proposal: ProposalView }
  | { kind: 'read'; read: ReadView }

export interface UserMessageView {
  id: string
  role: 'user'
  text: string
  chips: { label: string; words: number }[]
}

export interface ReplyView {
  id: string
  role: 'assistant'
  parts: ReplyPart[]
  streaming: boolean
  /** The reply stopped early (an error, Stop, the step limit). */
  incomplete: boolean
  stopped: boolean
  /** The quiet line under a reply while a tool runs ("Checking spelling in Chapter 3…"). */
  activity: string | null
  error: { kind: string; message: string } | null
  /** Retry is offered (the newest failed reply only). */
  canRetry: boolean
  /** A scripted reply (no AI call); `not-connected` shows "Connect a Provider…". */
  scripted: 'capabilities' | 'not-connected' | 'offline' | null
  /** Index of this reply's last assistant message in the stored chat (corrections are saved there). */
  storedIndex: number | null
}

export type MessageView = UserMessageView | ReplyView

export interface ModelsEntry {
  status: 'loading' | 'ready' | 'error'
  models: ModelInfo[]
}

interface ChatState {
  /** The history chat (useTutorHistory) this panel writes to; null before the first send. */
  chatId: string | null
  messages: MessageView[]
  chips: Chip[]
  draft: string
  busy: boolean
  view: 'chat' | 'history'
  /** The model chosen in the picker (the active connection's default when null). */
  modelId: string | null
  /** Model lists per connection id, loaded when the picker opens (or a send needs one). */
  models: Record<string, ModelsEntry>
  /** Bumped to ask the composer for the focus. */
  focusSeq: number
}

const initial = (): Omit<ChatState, 'models' | 'modelId'> => ({ chatId: null, messages: [], chips: [], draft: '', busy: false, view: 'chat', focusSeq: 0 })

export const useTutorChat = create<ChatState>()(() => ({ ...initial(), modelId: null, models: {} }))

const chat = () => useTutorChat.getState()
const set = (patch: Partial<ChatState> | ((s: ChatState) => Partial<ChatState>)) => useTutorChat.setState(patch)

let seq = 0
const newId = (p: string) => `${p}${++seq}`

// ---- Connections and models ----------------------------------------------------------------------

/** The connection the tutor uses now, or null. */
export function activeConnection(): Connection | null {
  const { list, activeId } = useStore.getState().tutorConnections
  return (list.find((c) => c.id === activeId) as Connection | undefined) ?? null
}

/** The model the panel will use with `c`: the one chosen in the picker, else the connection's default. */
export function chosenModel(c: Connection | null): string | null {
  if (!c) return null
  return chat().modelId ?? c.defaultModel ?? null
}

/** List `c`'s models (the picker opened, or a send without a model). Cached for the session. */
export async function loadModels(c: Connection): Promise<ModelInfo[]> {
  const have = chat().models[c.id]
  if (have?.status === 'ready') return have.models
  set((s) => ({ models: { ...s.models, [c.id]: { status: 'loading', models: have?.models ?? [] } } }))
  try {
    const models = await getAdapter(c.provider).listModels(c)
    set((s) => ({ models: { ...s.models, [c.id]: { status: 'ready', models } } }))
    return models
  } catch {
    set((s) => ({ models: { ...s.models, [c.id]: { status: 'error', models: [] } } }))
    return []
  }
}

/** The picker: use `modelId` of connection `connectionId`. */
export function chooseModel(connectionId: string, modelId: string, setActive: (id: string) => void): void {
  setActive(connectionId)
  set({ modelId })
}

/** A connection was saved or removed in Settings: list its models again next time (or set them, after a test). */
export function forgetModels(connectionId: string, models?: ModelInfo[]): void {
  set((s) => {
    const next = { ...s.models }
    if (models) next[connectionId] = { status: 'ready', models }
    else delete next[connectionId]
    return { models: next }
  })
}

/** The active connection changed elsewhere (Settings): forget a model chosen for the old one. */
export function connectionChanged(): void {
  set({ modelId: null })
}

// ---- Session and project -------------------------------------------------------------------------

let session: TutorSession | null = null
let unsubscribeSession: (() => void) | null = null
/** The chat as the model sees it (attached text included), without the panel's own fields. */
let modelHistory: ModelMessage[] = []
let abort: AbortController | null = null
let running: Promise<void> | null = null
/** Bumped when the chat is replaced or reset: a turn still finishing then changes nothing. */
let generation = 0
const reads = new Map<string, (ok: boolean) => void>()
/**
 * The failed turn Retry runs again, with its connection and model (the model may have been picked at
 * send, when the connection names no default: I2). Selection attachments follow edits (M3).
 */
let lastFailed: {
  replyId: string
  userText: string
  attachments: Attachment[]
  script: ScriptName | null
  history: ModelMessage[]
  connectionId: string
  modelId: string
} | null = null

function ensureSession(): TutorSession | null {
  const ed = getEditor()
  if (!ed || ed.isDestroyed) return null
  if (session && session.idx.editor === ed) return session
  disposeSession()
  session = createTutorSession(ed)
  const book = session.corrections
  unsubscribeSession = book.subscribe((changed) => mergeCorrections(changed, null))
  installChipMapping(ed)
  return session
}

function disposeSession() {
  unsubscribeSession?.()
  unsubscribeSession = null
  session?.dispose()
  session = null
}

/** The current session (tests, the correction list's availability checks). */
export const getTutorSession = (): TutorSession | null => session

/** Stop the reply under way and wait until its turn has finished. */
export async function stop(): Promise<void> {
  abort?.abort()
  await running
}

/** Forget the chat on screen (the greeting shows again); the stored chat stays in the history. */
function resetView(): void {
  generation++
  reads.forEach((respond) => respond(false))
  reads.clear()
  lastFailed = null
  modelHistory = []
  const keep = chat()
  set({ ...initial(), modelId: keep.modelId, models: keep.models, focusSeq: keep.focusSeq })
}

/** New Chat: stop the reply, start fresh (the greeting). */
export async function newChat(): Promise<void> {
  await stop()
  await useTutorHistory.getState().flush()
  resetView()
  disposeSession()
  requestComposerFocus()
}

/**
 * The panel closes: stop the reply, forget the chat on screen at once (an "Ask the Tutor" right after
 * starts afresh), then save the chat and close it in the history (must-do 4). A reply stopped this way
 * is not saved: the panel no longer shows it.
 */
export async function shutdown(): Promise<void> {
  abort?.abort()
  resetView()
  disposeSession()
  await running
  await useTutorHistory.getState().close()
}

/** Another project opened, or the project closed: stop and forget the chat (Review Focus 5). */
export function projectChanged(): void {
  abort?.abort()
  resetView()
  disposeSession()
}

/**
 * Before another manuscript replaces the open one (storage's registerBeforeDocumentReplace; C1): stop the
 * reply and forget the chat at once, so no tool of this turn reads the new text and nothing of it reaches
 * the provider or this chat; wait for the turn to unwind; then save the chat to the project it belongs
 * to, which is still the open one (M1), and close it.
 */
export async function beforeDocumentReplace(): Promise<void> {
  abort?.abort()
  resetView()
  disposeSession()
  await running
  await useTutorHistory.getState().close()
}

// ---- Chips ---------------------------------------------------------------------------------------

let unmapChips: (() => void) | null = null

/** Selection chips follow the writer's edits (must-do 3): their range is mapped through each transaction. */
function installChipMapping(ed: Editor) {
  unmapChips?.()
  const onTransaction = ({ transaction, appendedTransactions }: { transaction: Transaction; appendedTransactions: Transaction[] }) => {
    const trs = [transaction, ...appendedTransactions].filter((tr) => tr.docChanged)
    if (!trs.length) return
    const mapAttachment = (a: Attachment): Attachment => {
      if (a.kind !== 'selection') return a
      let { from, to } = a
      for (const tr of trs) {
        from = tr.mapping.map(from, 1)
        to = tr.mapping.map(to, -1)
      }
      return { kind: 'selection', from, to }
    }
    // A failed turn's selection follows the edits too, for Retry (M3).
    if (lastFailed?.attachments.some((a) => a.kind === 'selection')) lastFailed = { ...lastFailed, attachments: lastFailed.attachments.map(mapAttachment) }
    const chips = chat().chips
    if (!chips.some((c) => c.attachment.kind === 'selection')) return
    const next = chips
      .map((c) => (c.attachment.kind === 'selection' ? { ...c, attachment: mapAttachment(c.attachment) } : c))
      .filter((c) => c.attachment.kind !== 'selection' || c.attachment.to > c.attachment.from)
    set({ chips: next })
  }
  ed.on('transaction', onTransaction)
  unmapChips = () => ed.off('transaction', onTransaction)
}

const sameAttachment = (a: Attachment, b: Attachment) => JSON.stringify(a) === JSON.stringify(b)

/** Word count of an attachment for its chip (the store's counts for chapters and the book). */
function chipWords(a: Attachment): number {
  const s = useStore.getState()
  const ed = getEditor()
  switch (a.kind) {
    case 'manuscript':
      return s.wordCount.document.total.words
    case 'chapter':
      return s.wordCount.chapters[a.chapter - 1]?.counts.total.words ?? 0
    case 'page': {
      const page = s.layout.pages[a.page - 1]
      if (!page || !ed) return 0
      const c = countRange(ed.state.doc, page.from, page.to)
      return c.body.words + c.footnotes.words
    }
    case 'selection': {
      if (!ed) return 0
      const c = countRange(ed.state.doc, a.from, a.to)
      return c.body.words + c.footnotes.words
    }
  }
}

/** Add an attachment chip (once). `label` overrides the attachment's own ("Paragraph"). */
export function attach(a: Attachment, label?: string): void {
  const ed = getEditor()
  if (ed) ensureSession()
  if (chat().chips.some((c) => sameAttachment(c.attachment, a))) return
  const chip: Chip = { id: newId('chip'), attachment: a, label: label ?? attachmentLabel(a, ed?.state.doc), words: chipWords(a) }
  set((s) => ({ chips: [...s.chips, chip] }))
}

export function removeChip(id: string): void {
  set((s) => ({ chips: s.chips.filter((c) => c.id !== id) }))
}

/** The page the cursor is on, as the page indicator numbers it (1-based); null without a layout. */
export function currentPageAttachment(): Attachment | null {
  const l = useStore.getState().layout
  return l.pages[l.currentPage] ? { kind: 'page', page: l.currentPage + 1 } : null
}

/** The chapter the caret is in (the navigation pane's numbers, from 1); null in the front matter. */
export function currentChapterAttachment(): Attachment | null {
  const ed = getEditor()
  if (!ed) return null
  const index = chapterIndexAt(getChapters(ed.state.doc), ed.state.selection.from)
  return index >= 0 ? { kind: 'chapter', chapter: index + 1 } : null
}

/** The manuscript's selection, or null with a caret. */
export function selectionAttachment(): Attachment | null {
  const ed = getEditor()
  if (!ed) return null
  const { from, to, empty } = ed.state.selection
  return empty ? null : { kind: 'selection', from, to }
}

export function setDraft(draft: string): void {
  set({ draft })
}

export function requestComposerFocus(): void {
  set((s) => ({ focusSeq: s.focusSeq + 1 }))
}

export function showHistory(on: boolean): void {
  set({ view: on ? 'history' : 'chat' })
  if (on) void useTutorHistory.getState().refresh()
}

// ---- Replies -------------------------------------------------------------------------------------

function updateReply(id: string, fn: (r: ReplyView) => ReplyView): void {
  set((s) => ({ messages: s.messages.map((m) => (m.id === id && m.role === 'assistant' ? fn(m) : m)) }))
}

const emptyReply = (over: Partial<ReplyView> = {}): ReplyView => ({
  id: newId('r'),
  role: 'assistant',
  parts: [],
  streaming: false,
  incomplete: false,
  stopped: false,
  activity: null,
  error: null,
  canRetry: false,
  scripted: null,
  storedIndex: null,
  ...over,
})

/** Merge corrections by id wherever they are shown; new ones join reply `replyId`'s list. */
function mergeCorrections(items: Correction[], replyId: string | null): void {
  set((s) => {
    const pending = new Map(items.map((c) => [c.id, c]))
    const messages = s.messages.map((m) => {
      if (m.role !== 'assistant') return m
      let touched = false
      const parts = m.parts.map((p) => {
        if (p.kind !== 'corrections') return p
        const next = p.items.map((c) => {
          const u = pending.get(c.id)
          if (!u) return c
          pending.delete(c.id)
          touched = true
          return u
        })
        return touched ? { ...p, items: next } : p
      })
      return touched ? { ...m, parts } : m
    })
    if (pending.size && replyId) {
      const i = messages.findIndex((m) => m.id === replyId)
      const r = messages[i] as ReplyView | undefined
      if (r) {
        const fresh = [...pending.values()]
        const at = r.parts.findIndex((p) => p.kind === 'corrections')
        const parts = r.parts.slice()
        if (at >= 0) {
          const p = parts[at] as Extract<ReplyPart, { kind: 'corrections' }>
          parts[at] = { ...p, items: [...p.items, ...fresh] }
        } else parts.push({ kind: 'corrections', items: fresh })
        messages[i] = { ...r, parts }
      }
    }
    return { messages }
  })
}

const TOOL_ACTIVITY: Record<string, string> = {
  check_spelling: 'Checking spelling',
  check_grammar: 'Checking grammar',
  read_range: 'Reading',
  find_text: 'Searching',
  list_corrections: 'Listing corrections',
  propose_change: 'Preparing a suggestion',
  use_script: 'Choosing an approach',
}

/** "Checking spelling in Chapter 3…" (the attachment's name when there is one). */
function activityLine(tool: string, attachments: Attachment[]): string {
  const what = TOOL_ACTIVITY[tool] ?? 'Working'
  const doc = getEditor()?.state.doc
  const label = attachments.length === 1 ? attachmentLabel(attachments[0], doc).replace(/:.*$/, '') : null
  if (tool === 'read_range' || tool === 'find_text') return `${what} ${label ? label : 'the manuscript'}…`
  return label && (tool === 'check_spelling' || tool === 'check_grammar') ? `${what} in ${label}…` : `${what}…`
}

function onTurnEvent(replyId: string, gen: number, attachments: Attachment[], e: TurnEvent): void {
  if (gen !== generation) {
    if (e.type === 'read-request') e.respond(false)
    return
  }
  switch (e.type) {
    case 'text':
      updateReply(replyId, (r) => {
        const parts = r.parts.slice()
        const last = parts[parts.length - 1]
        if (last?.kind === 'text') parts[parts.length - 1] = { kind: 'text', text: last.text + e.delta }
        else parts.push({ kind: 'text', text: e.delta })
        return { ...r, parts }
      })
      break
    case 'tool':
      updateReply(replyId, (r) => ({ ...r, activity: e.status === 'start' ? activityLine(e.name, attachments) : null }))
      break
    case 'corrections':
      mergeCorrections(e.items, replyId)
      break
    case 'proposal':
      updateReply(replyId, (r) => ({ ...r, parts: [...r.parts, { kind: 'proposal', proposal: { id: newId('pr'), change: e.change, status: 'ready', note: null } }] }))
      break
    case 'read-request': {
      const id = newId('rd')
      reads.set(id, e.respond)
      updateReply(replyId, (r) => ({ ...r, parts: [...r.parts, { kind: 'read', read: { id, target: e.target, answer: 'pending' } }] }))
      break
    }
    case 'error':
      updateReply(replyId, (r) => ({ ...r, error: { kind: e.kind, message: e.message } }))
      break
    case 'done':
      updateReply(replyId, (r) => ({ ...r, streaming: false, activity: null, incomplete: e.incomplete || r.incomplete }))
      break
  }
}

/** Allow / Don't Allow on an inline read request. */
export function answerRead(readId: string, ok: boolean): void {
  const respond = reads.get(readId)
  reads.delete(readId)
  respond?.(ok)
  set((s) => ({
    messages: s.messages.map((m) =>
      m.role === 'assistant' && m.parts.some((p) => p.kind === 'read' && p.read.id === readId)
        ? { ...m, parts: m.parts.map((p) => (p.kind === 'read' && p.read.id === readId ? { ...p, read: { ...p.read, answer: ok ? 'allowed' : 'denied' } } : p)) }
        : m,
    ),
  }))
}

// ---- Sending -------------------------------------------------------------------------------------

/** The text a writer typed: attached `<manuscript>` blocks cut out (a stored user message). */
function typedText(m: StoredMessage): string {
  const c = m.content
  const text = typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => (p.type === 'text' ? p.text : '')).join(' ') : ''
  return text.replace(/<manuscript\b[^>]*>[\s\S]*?<\/manuscript>/gi, '').trim()
}

const formatCount = (n: number) => new Intl.NumberFormat().format(n)

function pushScripted(text: string, kind: ReplyView['scripted'], chips: Chip[] = []): void {
  const user: UserMessageView = { id: newId('u'), role: 'user', text, chips: chips.map((c) => ({ label: c.label, words: c.words })) }
  const name = kind ?? 'capabilities'
  const reply = emptyReply({ scripted: kind, parts: [{ kind: 'text', text: scriptedReply(name) }] })
  set((s) => ({ messages: [...s.messages, user, reply], draft: '' }))
}

/** "What can you do?": the written capabilities summary, no AI call. */
export function askCapabilities(): void {
  if (chat().busy) return
  pushScripted('What can you do?', 'capabilities')
}

export interface SendOptions {
  text?: string
  script?: ScriptName | null
  /** Chips to send (default: the composer's). */
  chips?: Chip[]
}

/** Why a model cannot run the tutor, or null. Unknown until the connection's models were listed. */
function modelProblem(c: Connection, modelId: string): string | null {
  const entry = chat().models[c.id]
  if (entry?.status !== 'ready') return null
  const m = entry.models.find((x) => x.id === modelId)
  return m && !modelSupportsTools(c, m) ? NO_TOOLS_REASON : null
}

/** ➤ / Enter: send the draft (or `opts.text`) with the chips. Resolves when the reply has finished. */
export async function send(opts: SendOptions = {}): Promise<void> {
  if (chat().busy) return
  const text = (opts.text ?? chat().draft).trim()
  const chips = opts.chips ?? chat().chips
  if (!text) return
  const connection = activeConnection()
  if (!connection) return pushScripted(text, 'not-connected', chips)
  if (typeof navigator !== 'undefined' && navigator.onLine === false && !USER_HOSTED_PROVIDERS.includes(connection.provider)) return pushScripted(text, 'offline', chips)
  const s = ensureSession()
  if (!s) return
  const attachments = chips.map((c) => c.attachment)
  const sent = attachments.map((a) => ({ a, ...attachmentText(a, s.idx) }))
  if (!(await confirmSend(connection, modelHistory, sent))) return
  let modelId = chosenModel(connection)
  if (!modelId) {
    set({ busy: true })
    const models = await loadModels(connection)
    set({ busy: false })
    modelId = models.find((m) => modelSupportsTools(connection, m))?.id ?? null
  }
  const user: UserMessageView = { id: newId('u'), role: 'user', text, chips: chips.map((c) => ({ label: c.label, words: c.words })) }
  const problem = modelId ? modelProblem(connection, modelId) : 'Choose a model for the tutor below.'
  if (problem || !modelId) {
    set((st) => ({ messages: [...st.messages, user, emptyReply({ error: { kind: 'bad_request', message: problem ?? '' } })], draft: '' }))
    return
  }
  set((st) => ({ messages: [...st.messages, user], draft: '', chips: opts.chips ? st.chips : [] }))
  const stored: StoredMessage['attachments'] = sent.map((x) => ({ label: attachmentLabel(x.a, s.idx.editor.state.doc), text: x.text }))
  await runTurn({ connection, modelId, userText: text, attachments, script: opts.script ?? null, stored })
}

/** Attached text, counted per line without its paragraph id ("[p12] " or "[p12 footnote 3] "). */
const blockWords = (body: string) => countText(body.replace(/^\[p\d+[^\]]*\] ?/gm, '')).words

/**
 * What earlier turns of the chat send again with every request: their attached `<manuscript>` blocks
 * (the chat is sent as it was, attached text included), and whether one of them is the whole book.
 */
export function historyPayload(history: readonly ModelMessage[]): { words: number; manuscript: boolean } {
  const whole = attachmentLabel({ kind: 'manuscript' })
  let words = 0
  let manuscript = false
  for (const m of history) {
    if (m.role !== 'user') continue
    const text = typeof m.content === 'string' ? m.content : m.content.map((p) => (p.type === 'text' ? p.text : '')).join('\n')
    for (const b of text.matchAll(/<manuscript source="([^"]*)">([\s\S]*?)<\/manuscript>/g)) {
      if (b[1] === whole) manuscript = true
      words += blockWords(b[2])
    }
  }
  return { words, manuscript }
}

/**
 * Consent (Settled point 8, I1): every request whose manuscript text is above CONFIRM_WORDS, or that
 * carries the whole book, asks first: the new attachments plus what the chat already holds and sends
 * again (a follow-up, Retry). Resolves false when the writer cancels.
 */
async function confirmSend(connection: Connection, history: readonly ModelMessage[], sent: { a: Attachment; words: number }[]): Promise<boolean> {
  const earlier = historyPayload(history)
  const words = earlier.words + sent.reduce((n, x) => n + x.words, 0)
  if (words <= CONFIRM_WORDS && !earlier.manuscript && !sent.some((x) => x.a.kind === 'manuscript')) return true
  set({ busy: true })
  const ok = await askConfirm('Send to the Tutor', `Send about ${formatCount(words)} words to ${connection.label}?`, 'Send')
  set({ busy: false })
  return ok
}

interface TurnInput {
  connection: Connection
  modelId: string
  userText: string
  attachments: Attachment[]
  script: ScriptName | null
  stored: StoredMessage['attachments']
  /** Retry: the chat before the failed turn. */
  history?: ModelMessage[]
}

async function runTurn(input: TurnInput): Promise<void> {
  const s = ensureSession()
  if (!s) return
  const history = useTutorHistory.getState()
  let chatId = chat().chatId
  if (!chatId || history.chat?.id !== chatId) {
    chatId = history.startNew({ connectionId: input.connection.id, modelId: input.modelId })
    set({ chatId })
  }
  const reply = emptyReply({ streaming: true })
  set((st) => ({ messages: [...st.messages.map((m) => (m.role === 'assistant' && m.canRetry ? { ...m, canRetry: false } : m)), reply], busy: true }))
  const gen = generation
  const before = input.history ?? modelHistory
  const controller = new AbortController()
  abort = controller
  let done!: () => void
  const mine = new Promise<void>((resolve) => (done = resolve))
  running = mine
  try {
    const result = await runTutorTurn({
      connection: input.connection,
      modelId: input.modelId,
      history: before,
      userText: input.userText,
      attachments: input.attachments,
      script: input.script,
      signal: controller.signal,
      session: s,
      onEvent: (e) => onTurnEvent(reply.id, gen, input.attachments, e),
    })
    if (gen !== generation) return
    const view = chat().messages.find((m) => m.id === reply.id) as ReplyView | undefined
    const stopped = controller.signal.aborted
    const failed = !!view?.error
    modelHistory = result
    const fresh = result.slice(before.length) as StoredMessage[]
    const base = useTutorHistory.getState().chat?.messages.length ?? 0
    let lastAssistant = -1
    fresh.forEach((m, i) => {
      if (m.role === 'assistant') lastAssistant = i
    })
    const corrections = view ? view.parts.flatMap((p) => (p.kind === 'corrections' ? p.items : [])) : []
    fresh.forEach((m, i) => {
      let msg: StoredMessage = m
      if (i === 0 && m.role === 'user') msg = { ...m, attachments: input.stored } as StoredMessage
      if (i === lastAssistant) msg = { ...m, ...(corrections.length ? { corrections } : {}), ...(view?.incomplete ? { incomplete: true } : {}) } as StoredMessage
      useTutorHistory.getState().append(chatId!, msg)
    })
    updateReply(reply.id, (r) => ({ ...r, stopped, canRetry: failed, storedIndex: lastAssistant >= 0 ? base + lastAssistant : null }))
    // A failed turn is kept as it came (marked incomplete); Retry asks again without it.
    lastFailed = failed
      ? { replyId: reply.id, userText: input.userText, attachments: input.attachments, script: input.script, history: before, connectionId: input.connection.id, modelId: input.modelId }
      : null
  } finally {
    if (abort === controller) abort = null
    if (gen === generation) set({ busy: false })
    done()
    // A newer turn may have started while this one unwound (after an abort): its promise stays (M2).
    if (running === mine) running = null
  }
}

/**
 * Retry on the newest failed reply: the same question and attachments (a selection where it is now), the
 * same connection and model (I2), the chat as it was before. Asks first like any send (I1).
 */
export async function retry(): Promise<void> {
  const f = lastFailed
  if (!f || chat().busy) return
  const list = useStore.getState().tutorConnections.list as Connection[]
  const connection = list.find((c) => c.id === f.connectionId) ?? activeConnection()
  const s = ensureSession()
  if (!connection || !s) return
  const sent = f.attachments.map((a) => ({ a, ...attachmentText(a, s.idx) }))
  if (!(await confirmSend(connection, f.history, sent))) return
  if (lastFailed !== f) return
  lastFailed = null
  const stored: StoredMessage['attachments'] = sent.map((x) => ({ label: attachmentLabel(x.a, s.idx.editor.state.doc), text: x.text }))
  await runTurn({ connection, modelId: f.modelId, userText: f.userText, attachments: f.attachments, script: f.script, stored, history: f.history })
}

/** A suggested prompt: its text, a script, and the attachment it needs (none for scripted ones). */
export async function sendPrompt(text: string, script: ScriptName, attachment: Attachment | null): Promise<void> {
  if (chat().busy) return
  const chips: Chip[] = [...chat().chips]
  if (attachment && !chips.some((c) => sameAttachment(c.attachment, attachment))) {
    chips.push({ id: newId('chip'), attachment, label: attachmentLabel(attachment, getEditor()?.state.doc), words: chipWords(attachment) })
  }
  set({ chips: [] })
  await send({ text, script, chips })
}

// ---- Corrections and proposals -------------------------------------------------------------------

/** The stored reply holding correction `id` (to save its new state there). */
function persistCorrections(replyId: string): void {
  const r = chat().messages.find((m) => m.id === replyId) as ReplyView | undefined
  const chatId = chat().chatId
  if (!r || r.storedIndex === null || !chatId) return
  const corrections = r.parts.flatMap((p) => (p.kind === 'corrections' ? p.items : []))
  useTutorHistory.getState().update(chatId, r.storedIndex, { corrections })
}

function findCorrection(id: string): { reply: ReplyView; correction: Correction } | null {
  for (const m of chat().messages) {
    if (m.role !== 'assistant') continue
    for (const p of m.parts) if (p.kind === 'corrections') for (const c of p.items) if (c.id === id) return { reply: m, correction: c }
  }
  return null
}

function setCorrectionState(id: string, state: 'applied' | 'ignored') {
  const found = findCorrection(id)
  if (!found) return
  mergeCorrections([{ ...found.correction, state }], null)
  persistCorrections(found.reply.id)
}

/** Fix: apply the correction at its paragraph as it is now (never anywhere else). */
export function fixCorrection(id: string): boolean {
  const found = findCorrection(id)
  if (!session || !found) return false
  const c = found.correction
  // Checked at the click (must-do 1): its paragraph as it is now, by id.
  if (!fixAvailability(session.idx, c).ok) return false
  // Applied first, so the edit's own refresh does not turn it 'changed' (its siblings in the paragraph do).
  session.corrections.setState(id, 'applied')
  applyCorrection(session.idx, c)
  setCorrectionState(id, 'applied')
  return true
}

export function ignoreCorrection(id: string): void {
  session?.corrections.setState(id, 'ignored')
  setCorrectionState(id, 'ignored')
}

export function jumpTo(id: string): boolean {
  const found = findCorrection(id)
  return !!session && !!found && jumpToCorrection(session.idx, found.correction)
}

/** Compare Side by Side: the proposal in the re-write view, or a note saying why not. */
export function openProposalView(proposalId: string): void {
  const s = session
  let target: ProposalView | null = null
  for (const m of chat().messages) if (m.role === 'assistant') for (const p of m.parts) if (p.kind === 'proposal' && p.proposal.id === proposalId) target = p.proposal
  if (!s || !target) return
  const outcome = openProposal(s.idx, target.change)
  const next: ProposalView = outcome.ok ? { ...target, status: 'opened', note: null } : { ...target, status: 'blocked', note: outcome.reason }
  set((st) => ({
    messages: st.messages.map((m) =>
      m.role === 'assistant' ? { ...m, parts: m.parts.map((p) => (p.kind === 'proposal' && p.proposal.id === proposalId ? { ...p, proposal: next } : p)) } : m,
    ),
  }))
}

// ---- History -------------------------------------------------------------------------------------

/** Strip the panel's fields from a stored message: what the model is sent. */
function asModelMessage(m: StoredMessage): ModelMessage {
  const { attachments: _a, corrections: _c, incomplete: _i, ...rest } = m
  void _a
  void _c
  void _i
  return rest as ModelMessage
}

function assistantText(m: StoredMessage): string {
  const c = m.content
  if (typeof c === 'string') return c
  return Array.isArray(c) ? c.map((p) => (p.type === 'text' ? p.text : '')).join('') : ''
}

/** The panel's view of a stored chat: user messages with their chips, each turn's replies as one. */
export function viewOfStored(messages: StoredMessage[]): MessageView[] {
  const out: MessageView[] = []
  let reply: ReplyView | null = null
  messages.forEach((m, i) => {
    if (m.role === 'user') {
      reply = null
      out.push({ id: newId('u'), role: 'user', text: typedText(m), chips: (m.attachments ?? []).map((a) => ({ label: a.label, words: 0 })) })
      return
    }
    if (m.role !== 'assistant') return
    if (!reply) {
      reply = emptyReply()
      out.push(reply)
    }
    const text = assistantText(m)
    if (text) {
      const last = reply.parts[reply.parts.length - 1]
      if (last?.kind === 'text') reply.parts[reply.parts.length - 1] = { kind: 'text', text: `${last.text}\n\n${text}` }
      else reply.parts.push({ kind: 'text', text })
    }
    // Corrections from an earlier session: their paragraph ids are gone, so they can no longer be applied.
    if (m.corrections?.length)
      reply.parts.push({
        kind: 'corrections',
        items: m.corrections.map((c) => ({ ...c, id: `h${i}-${c.id}`, state: c.state === 'open' ? 'changed' : c.state })),
      })
    if (m.incomplete) reply.incomplete = true
    reply.storedIndex = i
  })
  return out
}

/** Open a chat from the history (after the reply under way has finished: must-do 4). */
export async function openChat(id: string): Promise<void> {
  await stop()
  const history = useTutorHistory.getState()
  await history.open(id)
  const opened = useTutorHistory.getState().chat
  if (opened?.id !== id) return
  resetView()
  disposeSession()
  ensureSession()
  modelHistory = opened.messages.map(asModelMessage)
  set({ chatId: id, messages: viewOfStored(opened.messages), view: 'chat' })
  requestComposerFocus()
}

/** Delete a chat from the history (the one on screen too: the greeting shows). */
export async function deleteChat(id: string): Promise<void> {
  if (chat().chatId === id) {
    await stop()
    resetView()
    // Still in the list the delete was made from.
    set({ view: 'history' })
  }
  await useTutorHistory.getState().remove(id)
}

/** Test-only. */
export function __resetTutorChatForTests(): void {
  abort?.abort()
  generation++
  reads.clear()
  lastFailed = null
  modelHistory = []
  disposeSession()
  unmapChips?.()
  unmapChips = null
  useTutorChat.setState({ ...initial(), modelId: null, models: {} })
}
