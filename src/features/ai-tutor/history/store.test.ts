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
    state().append(user('Hello'))
    await vi.advanceTimersByTimeAsync(300)
    state().append(assistant('Hi there'))
    await vi.advanceTimersByTimeAsync(499)
    expect(saves()).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(2)
    expect(saves()).toHaveLength(1)
    expect(saves()[0].projectId).toBe('project-1')
    expect(saves()[0].chat).toMatchObject({ connectionId: 'c1', modelId: 'm1', messages: [user('Hello'), assistant('Hi there')] })
  })

  it('flushes a pending save on close', async () => {
    state().startNew()
    state().append(user('Hello'))
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
    state().append(user('One'))
    state().startNew()
    await vi.advanceTimersByTimeAsync(0)
    expect(saves().map((s) => s.chat.id)).toEqual([first])
    expect(state().chat!.id).not.toBe(first)
  })

  it('stores messages as sent, attachments and all, and update() replaces one', async () => {
    state().startNew()
    state().append({ ...user('<manuscript source="Page 1">\nThe text\n</manuscript>\nFix this'), attachments: [{ label: 'Page 1', text: 'The text' }] })
    state().append({ ...assistant('Done'), incomplete: true })
    state().update(1, { incomplete: false })
    await state().flush()
    const messages = saves().at(-1)!.chat.messages as Record<string, unknown>[]
    expect(messages[0].attachments).toEqual([{ label: 'Page 1', text: 'The text' }])
    expect(messages[1].incomplete).toBe(false)
  })

  it('serialises saves so an older write never lands after a newer one', async () => {
    state().startNew()
    state().append(user('A'))
    const first = state().flush()
    state().append(assistant('B'))
    const second = state().flush()
    await Promise.all([first, second])
    expect(saves().map((s) => (s.chat.messages as unknown[]).length)).toEqual([1, 2])
  })

  it('keeps the chat unsaved after a failed write, reports it, and retries on the next flush', async () => {
    state().startNew()
    state().append(user('Hello'))
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
    state().append(user(`<manuscript source="Page 1">\nBook text\n</manuscript>\n${'word '.repeat(30)}`))
    expect(state().chat!.title).toBe(('word '.repeat(30).trim()).slice(0, 60).trim())
    expect(state().chat!.title.length).toBeLessThanOrEqual(60)
    state().append(user('Another question'))
    expect(state().chat!.title.startsWith('word word')).toBe(true)
  })

  it('reads text parts of a structured user message and cuts at 60', () => {
    state().startNew()
    state().append({ role: 'user', content: [{ type: 'text', text: 'x'.repeat(100) }] })
    expect(state().chat!.title).toBe('x'.repeat(60))
  })

  it('falls back to "New chat" when the first message has only attached text', () => {
    state().startNew()
    state().append(user('<manuscript source="Page 1">\nBook text\n</manuscript>'))
    expect(state().chat!.title).toBe('New chat')
  })
})

describe('history store: the project changes under an open chat (Review Focus 5)', () => {
  it('does not write the old chat into the new project', async () => {
    state().startNew()
    state().append(user('Private to project 1'))
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
    state().append(user('late'))
    storage.meta = null
    await vi.advanceTimersByTimeAsync(2000)
    await state().flush()
    expect(saves()).toHaveLength(0)
    expect(state().chat).toBeNull()
  })

  it('drops the open chat when a project is opened', async () => {
    state().startNew()
    state().append(user('Hello'))
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
    state().append(user('Hello'))
    await state().flush()
    expect(saves()).toHaveLength(0)
    expect(state().chat!.messages).toHaveLength(1)
  })
})

describe('history store: the chat list', () => {
  it('opens, lists, removes and clears the projects chats', async () => {
    state().startNew()
    const a = state().chat!.id
    state().append(user('First chat'))
    state().startNew()
    const b = state().chat!.id
    state().append(user('Second chat'))
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
    state().append(user('Hello'))
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
    state().append(user('Hello'))
    await state().remove(id)
    await vi.advanceTimersByTimeAsync(2000)
    expect(saves()).toHaveLength(0)
    expect(backend.ai.history.get('project-1')?.has(id) ?? false).toBe(false)
  })
})
