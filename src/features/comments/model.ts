import type { CommentMessage, CommentThread } from '@/shared/store'

export type { CommentMessage, CommentThread }

/** comments.json (docs/project-format.md, "comments.json"). */
export const COMMENTS_FILE = 'comments.json'
export const COMMENTS_VERSION = 1

/** Ids Novel writes (and the only ones the highlight style sheet will name). */
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const COLOR_RE = /^#[0-9a-fA-F]{6}$/

export const isCommentId = (v: unknown): v is string => typeof v === 'string' && ID_RE.test(v)
export const isColor = (v: unknown): v is string => typeof v === 'string' && COLOR_RE.test(v)

export function newCommentId(): string {
  const c = globalThis.crypto
  const raw = c?.randomUUID ? c.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  return `c-${raw.replace(/[^A-Za-z0-9-]/g, '')}`
}

export interface Author {
  name: string
  color?: string | null
}

const THREAD_KEYS = ['id', 'createdAt', 'author', 'authorColor', 'resolved', 'resolvedBy', 'resolvedAt', 'messages'] as const
const MESSAGE_KEYS = ['id', 'author', 'date', 'text', 'editedAt'] as const

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isDate = (v: unknown): v is string => typeof v === 'string' && !Number.isNaN(Date.parse(v))

function extraOf(raw: Record<string, unknown>, known: readonly string[]): Record<string, unknown> | undefined {
  const extra: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(raw)) if (!known.includes(k)) extra[k] = v
  return Object.keys(extra).length ? extra : undefined
}

function parseMessage(raw: unknown): CommentMessage | null {
  if (!isObject(raw) || !isCommentId(raw.id) || typeof raw.text !== 'string') return null
  const extra = extraOf(raw, MESSAGE_KEYS)
  return {
    id: raw.id,
    author: typeof raw.author === 'string' ? raw.author : '',
    date: isDate(raw.date) ? raw.date : new Date(0).toISOString(),
    text: raw.text,
    ...(isDate(raw.editedAt) ? { editedAt: raw.editedAt } : {}),
    ...(extra ? { extra } : {}),
  }
}

/** A thread from comments.json, or null when it is not usable (it is then kept verbatim). */
export function parseThread(raw: unknown): CommentThread | null {
  if (!isObject(raw) || !isCommentId(raw.id) || !Array.isArray(raw.messages)) return null
  const messages = raw.messages.map(parseMessage)
  if (messages.length === 0 || messages.some((m) => m === null)) return null
  const extra = extraOf(raw, THREAD_KEYS)
  return {
    id: raw.id,
    createdAt: isDate(raw.createdAt) ? raw.createdAt : messages[0]!.date,
    author: typeof raw.author === 'string' ? raw.author : messages[0]!.author,
    ...(isColor(raw.authorColor) ? { authorColor: raw.authorColor } : {}),
    resolved: raw.resolved === true,
    ...(typeof raw.resolvedBy === 'string' ? { resolvedBy: raw.resolvedBy } : {}),
    ...(isDate(raw.resolvedAt) ? { resolvedAt: raw.resolvedAt } : {}),
    messages: messages as CommentMessage[],
    ...(extra ? { extra } : {}),
  }
}

export interface CommentsFileData {
  threads: CommentThread[]
  /** Unknown top-level keys. */
  extra: Record<string, unknown>
  /** Thread entries this version cannot use, written back unchanged after the others. */
  unreadable: unknown[]
  /** The file's `version` when it is newer than this Novel's. */
  newer?: number
}

/** Parse the JSON of comments.json (already an object; see the storage slice's side files). */
export function parseCommentsFile(data: unknown): CommentsFileData {
  if (!isObject(data)) return { threads: [], extra: {}, unreadable: [] }
  if (data.threads !== undefined && !Array.isArray(data.threads)) throw new Error('comments.json: threads is not a list')
  const extra = extraOf(data, ['version', 'threads']) ?? {}
  const list = Array.isArray(data.threads) ? data.threads : []
  const threads: CommentThread[] = []
  const unreadable: unknown[] = []
  const seen = new Set<string>()
  for (const raw of list) {
    const t = parseThread(raw)
    if (t && !seen.has(t.id)) {
      seen.add(t.id)
      threads.push(t)
    } else unreadable.push(raw)
  }
  const v = data.version
  return {
    threads,
    extra,
    unreadable,
    ...(typeof v === 'number' && Number.isInteger(v) && v > COMMENTS_VERSION ? { newer: v } : {}),
  }
}

function serializeMessage(m: CommentMessage): Record<string, unknown> {
  return {
    ...(m.extra ?? {}),
    id: m.id,
    author: m.author,
    date: m.date,
    text: m.text,
    ...(m.editedAt ? { editedAt: m.editedAt } : {}),
  }
}

export function serializeThread(t: CommentThread): Record<string, unknown> {
  return {
    ...(t.extra ?? {}),
    id: t.id,
    createdAt: t.createdAt,
    author: t.author,
    ...(t.authorColor ? { authorColor: t.authorColor } : {}),
    resolved: t.resolved,
    ...(t.resolvedBy !== undefined ? { resolvedBy: t.resolvedBy } : {}),
    ...(t.resolvedAt !== undefined ? { resolvedAt: t.resolvedAt } : {}),
    messages: t.messages.map(serializeMessage),
  }
}

/** comments.json content (written as version 1, like book.json after a newer file is replaced). */
export function serializeCommentsFile(file: Omit<CommentsFileData, 'newer'>): Record<string, unknown> {
  return { ...file.extra, version: COMMENTS_VERSION, threads: [...file.threads.map(serializeThread), ...file.unreadable] }
}

// ---- Thread changes (pure; each returns a new thread) --------------------------------------

const now = () => new Date().toISOString()

export function createThread(id: string, author: Author, text: string, at = now()): CommentThread {
  return {
    id,
    createdAt: at,
    author: author.name,
    ...(isColor(author.color) ? { authorColor: author.color } : {}),
    resolved: false,
    messages: [{ id: newCommentId(), author: author.name, date: at, text }],
  }
}

export function withReply(t: CommentThread, author: Author, text: string, at = now()): CommentThread {
  return { ...t, messages: [...t.messages, { id: newCommentId(), author: author.name, date: at, text }] }
}

export function withEditedMessage(t: CommentThread, messageId: string, text: string, at = now()): CommentThread | null {
  const i = t.messages.findIndex((m) => m.id === messageId)
  if (i < 0 || t.messages[i].text === text) return null
  const messages = t.messages.slice()
  messages[i] = { ...messages[i], text, editedAt: at }
  return { ...t, messages }
}

/** Without one reply. The first message is the comment itself: deleting it deletes the thread. */
export function withoutMessage(t: CommentThread, messageId: string): CommentThread | null {
  const i = t.messages.findIndex((m) => m.id === messageId)
  if (i <= 0) return null
  return { ...t, messages: t.messages.filter((m) => m.id !== messageId) }
}

export function withResolved(t: CommentThread, resolved: boolean, by: string, at = now()): CommentThread {
  if (resolved) return { ...t, resolved: true, resolvedBy: by, resolvedAt: at }
  const { resolvedBy: _b, resolvedAt: _a, ...rest } = t
  void _b
  void _a
  return { ...rest, resolved: false }
}

/** Trimmed message text with line breaks kept (\r\n -> \n). */
export function cleanText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/^\s+|\s+$/g, '')
}

/** "just now", "5 min ago", "3 h ago", "yesterday", or a short date. */
export function relativeDate(iso: string, nowMs = Date.now()): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  const s = Math.round((nowMs - t) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`
  if (s < 2 * 86_400) return 'yesterday'
  return new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: s > 300 * 86_400 ? 'numeric' : undefined })
}
