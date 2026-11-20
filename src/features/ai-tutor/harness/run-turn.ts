import type { Editor } from '@tiptap/core'
import type { Transaction } from '@tiptap/pm/state'
import { APICallError, stepCountIs, streamText, type ModelMessage } from 'ai'
import { getEditor } from '@/features/editor'
import type { Connection } from '../connections/types'
import { AiFetchError, type AiErrorKind } from '../net/tauri-fetch'
import { getAdapter } from '../providers/registry'
import { assembleSystem, type ScriptName } from './assemble'
import { wrapAttachments, type Attachment } from './attachments'
import { bookFacts } from './book-facts'
import { createCorrectionBook, createOutputTools, type Correction, type CorrectionBook, type ProposedChange } from './output-tools'
import { createParagraphIndex, followEditor, type ParagraphIndex } from './paragraph-index'
import { createReadTools } from './read-tools'

/** The most model calls (steps) in one turn. */
export const MAX_STEPS = 8

/**
 * What a turn tells the panel, in order; `done` is always last.
 * - `corrections`: corrections to show or update, merged by id (new ones from list_corrections, or
 *   ones whose state moved to 'changed' because the writer edited their paragraph).
 * - `read-request`: the tutor wants to read `target`; the panel asks "Allow?" and calls `respond`.
 * - `error`: a typed failure (kind from the proxy) with a human message; the panel offers Retry.
 * - `done`: `incomplete` when the reply stopped early (an error, Stop, or the step limit mid-tools).
 */
export type TurnEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool'; name: string; status: 'start' | 'done' }
  | { type: 'corrections'; items: Correction[] }
  | { type: 'proposal'; change: ProposedChange }
  | { type: 'read-request'; target: string; respond(ok: boolean): void }
  | { type: 'error'; kind: AiFetchError['kind']; message: string }
  | { type: 'done'; incomplete: boolean }

/**
 * A chat session's paragraph ids and corrections. It follows every transaction of the editor
 * (`followEditor`) for as long as it lives, so ids stay true through the writer's edits, and after each
 * edit it re-resolves the open corrections: one whose paragraph was touched turns 'changed' and the
 * subscribers of `corrections` hear of it (Review Focus 2), during a turn or after it.
 */
export interface TutorSession {
  readonly idx: ParagraphIndex
  readonly corrections: CorrectionBook
  dispose(): void
}

export function createTutorSession(editor: Editor): TutorSession {
  const idx = createParagraphIndex(editor)
  // Registered before the listener below: Tiptap calls listeners in order, so ids are mapped first.
  const unfollow = followEditor(idx)
  const corrections = createCorrectionBook(idx)
  const onTransaction = ({ transaction, appendedTransactions }: { transaction: Transaction; appendedTransactions: Transaction[] }) => {
    if (transaction.docChanged || appendedTransactions.some((tr) => tr.docChanged)) corrections.refresh()
  }
  editor.on('transaction', onTransaction)
  return {
    idx,
    corrections,
    dispose() {
      editor.off('transaction', onTransaction)
      unfollow()
    },
  }
}

const MESSAGES: Record<AiErrorKind, string> = {
  not_connected: 'The tutor is not connected. Check the connection in Settings.',
  blocked_host: 'The tutor may only talk to the connected provider.',
  bad_request: 'The provider could not accept the request.',
  auth: 'The provider did not accept the sign-in or key. Check the connection in Settings.',
  rate_limit: 'The provider is limiting requests. Wait a moment and try again.',
  network: 'The network connection to the provider failed.',
  provider: 'The provider had a problem with the reply.',
  cancelled: 'The request was stopped.',
}

function kindForStatus(status: number | undefined): AiErrorKind {
  if (status === 401 || status === 403) return 'auth'
  if (status === 429) return 'rate_limit'
  if (status !== undefined && status >= 400 && status < 500) return 'bad_request'
  return 'provider'
}

/**
 * A failure as the panel shows it. A proxy error keeps its kind and message (they never hold a secret);
 * anything else gets a fixed message for its kind, never the error's own text (it could quote a body).
 */
function turnError(e: unknown): { kind: AiErrorKind; message: string } {
  // The SDK wraps a proxy error that breaks a streaming body ("Failed to process successful response"),
  // so the whole cause chain is searched for it before an HTTP status is used.
  const chain: unknown[] = []
  for (let x: unknown = e; x && typeof x === 'object' && chain.length < 6; x = (x as { cause?: unknown }).cause ?? (x as { lastError?: unknown }).lastError) chain.push(x)
  const proxy = chain.find((x): x is AiFetchError => x instanceof AiFetchError)
  if (proxy) return { kind: proxy.kind, message: proxy.message }
  const api = chain.find((x) => APICallError.isInstance(x))
  const kind = api ? kindForStatus(api.statusCode) : 'provider'
  return { kind, message: MESSAGES[kind] }
}

const isAbort = (e: unknown, signal: AbortSignal) => signal.aborted || (e instanceof Error && e.name === 'AbortError') || (e instanceof DOMException && e.name === 'AbortError')

export interface TurnArgs {
  connection: Connection
  modelId: string
  /** The chat so far, as sent (attached text included). */
  history: ModelMessage[]
  userText: string
  attachments: Attachment[]
  /** The script chosen by a suggested prompt, or null (the model may pick one with use_script). */
  script: ScriptName | null
  signal: AbortSignal
  onEvent(e: TurnEvent): void
  /**
   * The chat's session (paragraph ids and corrections across turns). The panel keeps one per chat so
   * corrections keep updating after the turn; without it the turn makes its own on the manuscript editor
   * and drops it at the end.
   */
  session?: TutorSession
}

/**
 * One turn of the tutor: the writer's message (attachments wrapped as data before it) and the model's
 * reply, through `streamText` with the read and output tools, up to MAX_STEPS model calls. The system
 * prompt is the charter, the script (from `script`, or the one the model picks with use_script, from
 * the next step on) and the book facts.
 *
 * Retries are off (`maxRetries: 0`): the proxy does not give the SDK the provider's error bodies, so
 * the panel offers Retry instead. Returns the chat with this turn's messages: on an error or Stop, the
 * finished steps and the text that streamed (the partial reply stays).
 */
export async function runTutorTurn(args: TurnArgs): Promise<ModelMessage[]> {
  const { signal, onEvent, attachments } = args
  const editor = args.session ? null : getEditor()
  if (!args.session && !editor) {
    onEvent({ type: 'error', kind: 'bad_request', message: 'No manuscript is open.' })
    onEvent({ type: 'done', incomplete: true })
    return args.history
  }
  const session = args.session ?? createTutorSession(editor!)
  const { idx, corrections } = session
  const unsubscribe = corrections.subscribe((items) => onEvent({ type: 'corrections', items }))

  const wrapped = attachments.length ? wrapAttachments(attachments, idx) : ''
  const userMessage: ModelMessage = { role: 'user', content: wrapped ? `${wrapped}\n\n${args.userText}` : args.userText }
  const messages: ModelMessage[] = [...args.history, userMessage]

  let script = args.script
  const instructions = () => `${assembleSystem(script)}\n\n${bookFacts()}`

  const pendingReads = new Set<(ok: boolean) => void>()
  const requestRead = (target: string) =>
    new Promise<boolean>((resolve) => {
      if (signal.aborted) return resolve(false)
      let answered = false
      const respond = (ok: boolean) => {
        if (answered) return
        answered = true
        pendingReads.delete(respond)
        resolve(ok && !signal.aborted)
      }
      pendingReads.add(respond)
      onEvent({ type: 'read-request', target, respond })
    })
  const denyPending = () => {
    for (const respond of [...pendingReads]) respond(false)
  }
  signal.addEventListener('abort', denyPending)

  const tools = {
    ...createReadTools({ idx, scope: { attachments }, requestRead, onScript: (name) => (script = name) }),
    ...createOutputTools({
      idx,
      corrections,
      onCorrections: (items) => onEvent({ type: 'corrections', items }),
      onProposal: (change) => onEvent({ type: 'proposal', change }),
    }),
  }

  /** Response messages of the finished steps, in order. */
  const stepMessages: ModelMessage[] = []
  /** Text of the step under way. */
  let partial = ''
  let incomplete = false
  let failed = false
  const started = new Map<string, string>()
  const toolStart = (id: string, name: string) => {
    if (started.has(id)) return
    started.set(id, name)
    onEvent({ type: 'tool', name, status: 'start' })
  }
  const toolDone = (id: string, name: string) => {
    if (started.get(id) === undefined) return
    started.set(id, '')
    onEvent({ type: 'tool', name, status: 'done' })
  }
  const fail = (e: unknown) => {
    incomplete = true
    if (failed || isAbort(e, signal)) return
    failed = true
    onEvent({ type: 'error', ...turnError(e) })
  }

  try {
    const model = getAdapter(args.connection.provider).languageModel(args.connection, args.modelId)
    const result = streamText({
      model,
      instructions: instructions(),
      messages,
      tools,
      stopWhen: stepCountIs(MAX_STEPS),
      maxRetries: 0,
      abortSignal: signal,
      // use_script takes effect from the next step: the instructions are rebuilt before each one.
      prepareStep: () => ({ instructions: instructions() }),
      onStepEnd: (step) => {
        stepMessages.push(...step.response.messages)
        partial = ''
      },
      // Errors arrive as stream parts below; the default handler would log them.
      onError: () => {},
    })
    for await (const part of result.fullStream) {
      switch (part.type) {
        case 'text-delta':
          if (!part.text) break
          partial += part.text
          onEvent({ type: 'text', delta: part.text })
          break
        case 'tool-input-start':
          toolStart(part.id, part.toolName)
          break
        case 'tool-call':
          toolStart(part.toolCallId, part.toolName)
          break
        case 'tool-result':
        case 'tool-error':
          toolDone(part.toolCallId, part.toolName)
          break
        case 'error':
          fail(part.error)
          break
        case 'abort':
          incomplete = true
          break
        case 'finish':
          // The step limit was reached while the model was still calling tools: no final answer.
          if (part.finishReason === 'tool-calls') incomplete = true
          break
      }
    }
    if (signal.aborted) incomplete = true
  } catch (e) {
    fail(e)
  } finally {
    signal.removeEventListener('abort', denyPending)
    denyPending()
    unsubscribe()
    if (!args.session) session.dispose()
    onEvent({ type: 'done', incomplete })
  }
  return [...messages, ...stepMessages, ...(partial ? [{ role: 'assistant' as const, content: partial }] : [])]
}
