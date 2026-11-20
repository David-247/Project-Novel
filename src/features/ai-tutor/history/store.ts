import { create } from 'zustand'
import { getCurrentProjectMeta, onProjectOpened } from '@/features/storage'
import * as ipc from './ipc'
import type { Chat, ChatSummary, StoredMessage } from './types'

/**
 * The tutor's chat history: the open chat and the open project's chat list. Chats are saved through
 * Rust into the app data folder, keyed by the project's `meta.id` (never in the project folder).
 *
 * Review Focus 5: a chat belongs to the project that was open when it was started or opened. Before
 * every write the open project's id is read again; if it changed (another project opened, or the
 * project closed) the chat is dropped and nothing is written, so a chat can never land in another
 * project's history. Without an open project a chat lives in memory only.
 */

/** A change is saved this long after the last one (and at once on `flush`, `close`, `startNew`, `open`). */
export const SAVE_DEBOUNCE_MS = 500

const NEW_CHAT_TITLE = 'New chat'
const TITLE_CHARS = 60
const FALLBACK_ERROR = 'The chat history could not be saved.'

interface HistoryState {
  /** The project (its meta.id) the open chat belongs to; null when none was open. */
  projectId: string | null
  chat: Chat | null
  /** The open project's saved chats, newest first (`refresh`). */
  chats: ChatSummary[]
  /** The last failure, in words; never the chat's text. */
  error: string | null
  /** Start an empty chat; returns its id, the handle later writes to it must name. */
  startNew(opts?: { connectionId?: string; modelId?: string }): string
  open(id: string): Promise<void>
  /**
   * Add a message to chat `chatId` and schedule the save. A write is bound to its chat: if that chat is
   * no longer the open one (another project, a new chat, another chat opened) it is dropped, so a turn
   * that streams on after a switch cannot land in the wrong chat (Review Focus 5).
   */
  append(chatId: string, message: StoredMessage): void
  /** Change the message at `index` of chat `chatId` (the streamed reply being finished, a correction applied); dropped like `append`. */
  update(chatId: string, index: number, patch: Partial<StoredMessage>): void
  /** Save now. Resolves once every queued write has finished. */
  flush(): Promise<void>
  /** The panel closes: save what is pending, then forget the open chat. */
  close(): Promise<void>
  refresh(): Promise<void>
  remove(id: string): Promise<void>
  /** Delete all of the open project's chats (Task 10's settings page; the delete-project prompt). */
  clearProject(): Promise<void>
  /** Delete every project's chats (the settings page's "Clear all"). */
  clearAll(): Promise<void>
}

let dirty = false
let timer: ReturnType<typeof setTimeout> | null = null
/** Writes run one after another, so an older snapshot never lands after a newer one. */
let queue: Promise<void> = Promise.resolve()
/**
 * Bumped whenever the open chat is replaced, dropped or edited. `open` loads a chat asynchronously and
 * discards the result if this moved meanwhile: the simpler choice than merging, and it never loses edits.
 */
let generation = 0

/** Run `task` after every write and delete queued before it (saves and deletes share one queue). */
function enqueue(task: () => Promise<void>): Promise<void> {
  queue = queue.then(task)
  return queue
}

const currentProjectId = (): string | null => getCurrentProjectMeta()?.id ?? null

function messageOf(e: unknown, fallback: string): string {
  const m = (e as { message?: unknown } | null)?.message
  return typeof m === 'string' && m ? m : fallback
}

function cancelTimer() {
  if (timer) clearTimeout(timer)
  timer = null
}

/** The text a writer typed: attached `<manuscript>` blocks are cut out. */
function userText(message: StoredMessage): string {
  const c = message.content
  const text = typeof c === 'string' ? c : c.map((p) => (p.type === 'text' ? p.text : '')).join(' ')
  return text.replace(/<manuscript\b[^>]*>[\s\S]*?<\/manuscript>/gi, ' ')
}

/** The first 60 characters of the first user message. */
export function chatTitle(message: StoredMessage): string {
  const text = userText(message).replace(/\s+/g, ' ').trim()
  return Array.from(text).slice(0, TITLE_CHARS).join('').trim() || NEW_CHAT_TITLE
}

export const useTutorHistory = create<HistoryState>()((set, get) => {
  /** The open chat if it still belongs to the open project; otherwise drop it (and what is unsaved). */
  function validChat(): Chat | null {
    const { chat, projectId } = get()
    if (!chat) return null
    if (projectId === currentProjectId()) return chat
    drop()
    return null
  }

  function drop() {
    generation++
    cancelTimer()
    dirty = false
    set({ chat: null, projectId: null })
  }

  function touch(next: Chat) {
    generation++
    set({ chat: { ...next, updatedAt: new Date().toISOString() } })
    dirty = true
    cancelTimer()
    timer = setTimeout(() => void get().flush(), SAVE_DEBOUNCE_MS)
  }

  function flush(): Promise<void> {
    cancelTimer()
    const chat = validChat()
    const projectId = get().projectId
    if (dirty && chat && projectId) {
      dirty = false
      void enqueue(async () => {
        // The project may have changed while this write waited its turn.
        if (currentProjectId() !== projectId) return
        try {
          await ipc.saveChat(projectId, chat)
          set({ error: null })
        } catch (e) {
          // Keep it unsaved: the next change or flush tries again.
          if (get().chat?.id === chat.id) dirty = true
          set({ error: messageOf(e, FALLBACK_ERROR) })
        }
      })
    } else if (dirty && chat && !projectId) {
      dirty = false // no project open: nothing to save to
    }
    return queue
  }

  return {
    projectId: null,
    chat: null,
    chats: [],
    error: null,

    startNew(opts) {
      void flush()
      const now = new Date().toISOString()
      const id = crypto.randomUUID()
      generation++
      dirty = false
      set({
        projectId: currentProjectId(),
        chat: {
          id,
          title: NEW_CHAT_TITLE,
          createdAt: now,
          updatedAt: now,
          connectionId: opts?.connectionId ?? '',
          modelId: opts?.modelId ?? '',
          messages: [],
        },
      })
      return id
    },

    async open(id) {
      const gen = generation // from the call, so edits made while the flush or the load runs also count
      await flush()
      const projectId = currentProjectId()
      if (!projectId) {
        set({ error: 'Open a project to see its chats.' })
        return
      }
      try {
        const chat = await ipc.loadChat(projectId, id)
        // The chat changed while loading (a new chat, an edit): keep that, discard this.
        if (currentProjectId() !== projectId || gen !== generation) return
        dirty = false
        cancelTimer()
        set({ chat, projectId, error: null })
      } catch (e) {
        set({ error: messageOf(e, 'The chat could not be opened.') })
      }
    },

    append(chatId, message) {
      const chat = validChat()
      if (!chat || chat.id !== chatId) return
      const first = message.role === 'user' && !chat.messages.some((m) => m.role === 'user')
      touch({ ...chat, title: first ? chatTitle(message) : chat.title, messages: [...chat.messages, message] })
    },

    update(chatId, index, patch) {
      const chat = validChat()
      if (!chat || chat.id !== chatId || index < 0 || index >= chat.messages.length) return
      const messages = chat.messages.slice()
      messages[index] = { ...messages[index], ...patch } as StoredMessage
      touch({ ...chat, messages })
    },

    flush,

    async close() {
      const done = flush()
      drop()
      await done
    },

    async refresh() {
      const projectId = currentProjectId()
      if (!projectId) {
        set({ chats: [] })
        return
      }
      try {
        const chats = await ipc.listChats(projectId)
        if (currentProjectId() === projectId) set({ chats, error: null })
      } catch (e) {
        set({ error: messageOf(e, 'The chats could not be listed.') })
      }
    },

    async remove(id) {
      if (get().chat?.id === id) drop()
      const projectId = currentProjectId()
      if (!projectId) return
      await enqueue(async () => {
        try {
          await ipc.deleteChats(projectId, id)
          set({ error: null })
        } catch (e) {
          set({ error: messageOf(e, 'The chat could not be deleted.') })
        }
      })
      await get().refresh()
    },

    async clearProject() {
      const projectId = currentProjectId()
      if (!projectId) return
      drop()
      await enqueue(async () => {
        try {
          await ipc.deleteChats(projectId)
          set({ chats: [], error: null })
        } catch (e) {
          set({ error: messageOf(e, 'The chats could not be deleted.') })
        }
      })
    },

    async clearAll() {
      drop()
      await enqueue(async () => {
        try {
          await ipc.clearAllChats()
          set({ chats: [], error: null })
        } catch (e) {
          set({ error: messageOf(e, 'The chats could not be deleted.') })
        }
      })
    },
  }
})

// A project was opened: the open chat and the list belong to the previous one.
onProjectOpened(() => {
  generation++
  cancelTimer()
  dirty = false
  useTutorHistory.setState({ chat: null, projectId: null, chats: [] })
})

/** Test helper: forget everything (waits for queued writes). */
export async function resetTutorHistory(): Promise<void> {
  cancelTimer()
  dirty = false
  await queue
  useTutorHistory.setState({ chat: null, projectId: null, chats: [], error: null })
}
