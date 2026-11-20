import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { backend } from '@/test-utils/fake-tauri'

vi.mock('@tauri-apps/api/core', async () => (await import('@/test-utils/fake-tauri')).coreModule)

// The storage slice's public interface: the open project's meta.id and "a project was opened".
const storage = vi.hoisted(() => ({
  meta: { id: 'project-1' } as { id: string } | null,
  listeners: new Set<() => void>(),
}))
vi.mock('@/features/storage', () => ({
  getCurrentProjectMeta: () => storage.meta,
  onProjectOpened: (cb: () => void) => {
    storage.listeners.add(cb)
    return () => storage.listeners.delete(cb)
  },
}))

import { resetTutorHistory, SAVE_DEBOUNCE_MS, useTutorHistory } from './store'

const state = () => useTutorHistory.getState()
const user = (content: string) => ({ role: 'user' as const, content })
const assistant = (content: string) => ({ role: 'assistant' as const, content })
const saves = () => backend.ai.historySaves
// Writes name the chat they belong to; these act on whichever chat is open right now.
const add = (m: Parameters<ReturnType<typeof useTutorHistory.getState>['append']>[1]) => state().append(state().chat!.id, m)
const upd = (i: number, p: Parameters<ReturnType<typeof useTutorHistory.getState>['update']>[2]) => state().update(state().chat!.id, i, p)

beforeEach(async () => {
  vi.useFakeTimers()
  backend.reset()
  storage.meta = { id: 'project-1' }
  await resetTutorHistory()
})

afterEach(() => vi.useRealTimers())

describe('history store: saving', () => {
  it('debounces the save by 500 ms and writes the whole chat once', async () => {
    expect(SAVE_DEBOUNCE_MS).toBe(500)
    state().startNew({ connectionId: 'c1', modelId: 'm1' })
    add(user('Hello'))
    await vi.advanceTimersByTimeAsync(300)
    add(assistant('Hi there'))
    await vi.advanceTimersByTimeAsync(499)
    expect(saves()).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(2)
    expect(saves()).toHaveLength(1)
    expect(saves()[0].projectId).toBe('project-1')
    expect(saves()[0].chat).toMatchObject({ connectionId: 'c1', modelId: 'm1', messages: [user('Hello'), assistant('Hi there')] })
  })

  it('flushes a pending save on close', async () => {
    state().startNew()
    add(user('Hello'))
    expect(saves()).toHaveLength(0)
    await state().close()
    expect(saves()).toHaveLength(1)
    expect(state().chat).toBeNull()
    await vi.advanceTimersByTimeAsync(2000)
    expect(saves()).toHaveLength(1)
  })

  it('starting a new chat flushes the old one first', async () => {
    state().startNew()
    const first = state().chat!.id
    add(user('One'))
    state().startNew()
    await vi.advanceTimersByTimeAsync(0)
    expect(saves().map((s) => s.chat.id)).toEqual([first])
    expect(state().chat!.id).not.toBe(first)
  })

  it('stores messages as sent, attachments and all, and update() replaces one', async () => {
    state().startNew()
    add({ ...user('<manuscript source="Page 1">\nThe text\n</manuscript>\nFix this'), attachments: [{ label: 'Page 1', text: 'The text' }] })
    add({ ...assistant('Done'), incomplete: true })
    upd(1, { incomplete: false })
    await state().flush()
    const messages = saves().at(-1)!.chat.messages as Record<string, unknown>[]
    expect(messages[0].attachments).toEqual([{ label: 'Page 1', text: 'The text' }])
    expect(messages[1].incomplete).toBe(false)
  })

  it('serialises saves so an older write never lands after a newer one', async () => {
    state().startNew()
    add(user('A'))
    const first = state().flush()
    add(assistant('B'))
    const second = state().flush()
    await Promise.all([first, second])
    expect(saves().map((s) => (s.chat.messages as unknown[]).length)).toEqual([1, 2])
  })

  it('keeps the chat unsaved after a failed write, reports it, and retries on the next flush', async () => {
    state().startNew()
    add(user('Hello'))
    backend.ai.failHistory = true
    await state().flush()
    expect(state().error).toBeTruthy()
    expect(state().error).not.toContain('Hello')
    backend.ai.failHistory = false
    await state().flush()
    expect(state().error).toBeNull()
    expect(saves()).toHaveLength(1)
  })
})

describe('history store: titles', () => {
  it('is the first 60 characters of the first user message, without attached text', () => {
    state().startNew()
    add(user(`<manuscript source="Page 1">\nBook text\n</manuscript>\n${'word '.repeat(30)}`))
    expect(state().chat!.title).toBe(('word '.repeat(30).trim()).slice(0, 60).trim())
    expect(state().chat!.title.length).toBeLessThanOrEqual(60)
    add(user('Another question'))
    expect(state().chat!.title.startsWith('word word')).toBe(true)
  })

  it('reads text parts of a structured user message and cuts at 60', () => {
    state().startNew()
    add({ role: 'user', content: [{ type: 'text', text: 'x'.repeat(100) }] })
    expect(state().chat!.title).toBe('x'.repeat(60))
  })

  it('falls back to "New chat" when the first message has only attached text', () => {
    state().startNew()
    add(user('<manuscript source="Page 1">\nBook text\n</manuscript>'))
    expect(state().chat!.title).toBe('New chat')
  })
})

describe('history store: the project changes under an open chat (Review Focus 5)', () => {
  it('does not write the old chat into the new project', async () => {
    state().startNew()
    add(user('Private to project 1'))
    storage.meta = { id: 'project-2' }
    await vi.advanceTimersByTimeAsync(2000)
    expect(saves()).toHaveLength(0)
    await state().flush()
    expect(saves()).toHaveLength(0)
    expect(backend.ai.history.size).toBe(0)
  })

  it('ignores an append for a chat opened under another project, and a closed project', async () => {
    state().startNew()
    storage.meta = { id: 'project-2' }
    add(user('late'))
    storage.meta = null
    await vi.advanceTimersByTimeAsync(2000)
    await state().flush()
    expect(saves()).toHaveLength(0)
    expect(state().chat).toBeNull()
  })

  it('Save As (the text kept) moves the open chat into the new project, with its id, and saves it there (final C-M1)', async () => {
    // Untitled: the chat lives in memory only.
    storage.meta = null
    const id = state().startNew()
    add(user('Hello'))
    storage.meta = { id: 'project-2' }
    ;(storage.listeners as Set<(p: unknown) => void>).forEach((cb) => cb({ path: '/books/new', meta: storage.meta, keptText: true }))
    expect(state().chat?.id).toBe(id)
    expect(state().projectId).toBe('project-2')
    // A late write of the turn still streaming lands in the moved chat.
    state().append(id, assistant('Hi'))
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS + 10)
    expect(saves().map((s) => s.projectId)).toEqual(['project-2'])
    expect(saves()[0].chat.messages).toEqual([user('Hello'), assistant('Hi')])
  })

  it('drops the open chat when a project is opened', async () => {
    state().startNew()
    add(user('Hello'))
    storage.meta = { id: 'project-2' }
    storage.listeners.forEach((cb) => cb())
    expect(state().chat).toBeNull()
    expect(state().chats).toEqual([])
    await vi.advanceTimersByTimeAsync(2000)
    expect(saves()).toHaveLength(0)
  })

  it('writes nothing when no project is open', async () => {
    storage.meta = null
    state().startNew()
    add(user('Hello'))
    await state().flush()
    expect(saves()).toHaveLength(0)
    expect(state().chat!.messages).toHaveLength(1)
  })
})

describe('history store: the chat list', () => {
  it('opens, lists, removes and clears the projects chats', async () => {
    state().startNew()
    const a = state().chat!.id
    add(user('First chat'))
    state().startNew()
    const b = state().chat!.id
    add(user('Second chat'))
    await state().flush()
    await state().refresh()
    expect(state().chats.map((c) => c.id).sort()).toEqual([a, b].sort())

    await state().open(a)
    expect(state().chat!.messages).toEqual([user('First chat')])

    await state().remove(a)
    expect(state().chat).toBeNull()
    expect(state().chats.map((c) => c.id)).toEqual([b])

    await state().clearProject()
    expect(state().chats).toEqual([])
    expect(backend.ai.history.has('project-1')).toBe(false)
  })

  it('does not open a chat of another project', async () => {
    state().startNew()
    add(user('Hello'))
    await state().flush()
    const id = state().chat!.id
    await state().close()
    storage.meta = { id: 'project-2' }
    await state().open(id)
    expect(state().chat).toBeNull()
    expect(state().error).toBeTruthy()
  })

  it('clears a deleted chat that was open without writing it back', async () => {
    state().startNew()
    const id = state().chat!.id
    add(user('Hello'))
    await state().remove(id)
    await vi.advanceTimersByTimeAsync(2000)
    expect(saves()).toHaveLength(0)
    expect(backend.ai.history.get('project-1')?.has(id) ?? false).toBe(false)
  })
})

describe('history store: late writes are bound to their chat', () => {
  it('drops a late append after a project switch and a new chat', async () => {
    const old = state().startNew()
    add(user('Question'))
    storage.meta = { id: 'project-2' }
    storage.listeners.forEach((cb) => cb())
    const fresh = state().startNew()
    state().append(old, assistant('Reply to project 1'))
    expect(state().chat!.id).toBe(fresh)
    expect(state().chat!.messages).toEqual([])
    await state().flush()
    expect(saves()).toHaveLength(0)
  })

  it('drops a late update after another chat was opened', async () => {
    const a = state().startNew()
    add(user('First'))
    add(assistant('Streaming'))
    await state().flush()
    const b = state().startNew()
    add(user('Second'))
    await state().flush()
    await state().open(a)
    await state().open(b)
    state().update(a, 1, { content: 'Wrong chat' })
    state().append(a, assistant('Wrong chat'))
    expect(state().chat!.id).toBe(b)
    expect(state().chat!.messages).toEqual([user('Second')])
    await state().flush()
    expect(saves()).toHaveLength(2)
  })
})

describe('history store: deletes share the write queue', () => {
  it('runs a save queued during clearProject after the delete', async () => {
    state().startNew()
    add(user('Old'))
    await state().flush()
    const clearing = state().clearProject()
    const id = state().startNew()
    add(user('New'))
    const saving = state().flush()
    await Promise.all([clearing, saving])
    expect([...(backend.ai.history.get('project-1')?.keys() ?? [])]).toEqual([id])
  })

  it('runs a save queued during remove after the delete', async () => {
    const a = state().startNew()
    add(user('Old'))
    await state().flush()
    const removing = state().remove(a)
    state().startNew()
    add(user('New'))
    await Promise.all([removing, state().flush()])
    expect(backend.ai.history.get('project-1')?.has(a)).toBe(false)
    expect(backend.ai.history.get('project-1')?.size).toBe(1)
  })

  it('clearAll deletes every project after pending saves', async () => {
    storage.meta = { id: 'project-1' }
    state().startNew()
    add(user('Old'))
    await state().flush()
    await state().clearAll()
    expect(backend.ai.history.size).toBe(0)
    expect(state().chat).toBeNull()
  })
})

describe('history store: open() while the chat changes', () => {
  it('discards the loaded chat when a new chat was started and edited meanwhile', async () => {
    const a = state().startNew()
    add(user('Saved'))
    await state().flush()
    await state().close()
    const opening = state().open(a)
    const fresh = state().startNew()
    add(user('Typed while loading'))
    await opening
    expect(state().chat!.id).toBe(fresh)
    expect(state().chat!.messages).toEqual([user('Typed while loading')])
    await state().flush()
    expect(saves().at(-1)!.chat.id).toBe(fresh)
  })
});
