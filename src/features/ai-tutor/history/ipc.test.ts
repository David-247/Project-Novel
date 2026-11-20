import { beforeEach, describe, expect, it, vi } from 'vitest'
import { backend } from '@/test-utils/fake-tauri'
import * as ipc from './ipc'
import type { Chat } from './types'

vi.mock('@tauri-apps/api/core', async () => (await import('@/test-utils/fake-tauri')).coreModule)

beforeEach(() => backend.reset())

const chat = (id: string, updatedAt = '2026-11-19T10:00:00.000Z'): Chat => ({
  id,
  title: `t ${id}`,
  createdAt: updatedAt,
  updatedAt,
  connectionId: 'c1',
  modelId: 'm1',
  messages: [{ role: 'user', content: 'Hi', attachments: [{ label: 'Page 1', text: 'As sent' }] }],
})

describe('history ipc', () => {
  it('saves, lists, loads and deletes a project\'s chats', async () => {
    await ipc.saveChat('p-1', chat('a', '2026-11-19T10:00:00.000Z'))
    await ipc.saveChat('p-1', chat('b', '2026-11-19T11:00:00.000Z'))
    await ipc.saveChat('p-2', chat('a'))
    expect((await ipc.listChats('p-1')).map((c) => c.id)).toEqual(['b', 'a'])
    expect(await ipc.loadChat('p-1', 'a')).toEqual(chat('a', '2026-11-19T10:00:00.000Z'))
    await ipc.deleteChats('p-1', 'a')
    expect((await ipc.listChats('p-1')).map((c) => c.id)).toEqual(['b'])
    await ipc.deleteChats('p-1')
    expect(await ipc.listChats('p-1')).toEqual([])
    expect(await ipc.listChats('p-2')).toHaveLength(1)
    await ipc.clearAllChats()
    expect(await ipc.listChats('p-2')).toEqual([])
  })

  it('rejects ids that could leave the folder, as bad_request', async () => {
    await expect(ipc.listChats('../x')).rejects.toMatchObject({ kind: 'bad_request' })
    await expect(ipc.saveChat('p-1', chat('a/b'))).rejects.toMatchObject({ kind: 'bad_request' })
    await expect(ipc.loadChat('p-1', '..')).rejects.toMatchObject({ kind: 'bad_request' })
    for (const name of ['CON', 'nul', 'Com1', 'LPT9']) {
      await expect(ipc.listChats(name)).rejects.toMatchObject({ kind: 'bad_request' })
      await expect(ipc.saveChat('p-1', chat(name))).rejects.toMatchObject({ kind: 'bad_request' })
    }
  })
})
