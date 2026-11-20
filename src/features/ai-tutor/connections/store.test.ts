import { beforeEach, describe, expect, it, vi } from 'vitest'
import { backend } from '@/test-utils/fake-tauri'
import { useStore } from '@/shared/store'
import * as ipc from './ipc'
import { loadTutorConnections, removeTutorConnection, setActiveTutorConnection, upsertTutorConnection } from './store'
import type { Connection } from './types'

vi.mock('@tauri-apps/api/core', async () => (await import('@/test-utils/fake-tauri')).coreModule)

const claude: Connection = { id: 'c1', provider: 'anthropic', label: 'Claude', auth: 'api_key' }
const local: Connection = { id: 'c2', provider: 'ollama', label: 'Ollama', auth: 'none', baseUrl: 'http://localhost:11434/v1' }

const slice = () => useStore.getState().tutorConnections
const pref = () => useStore.getState().preferences.tutorActiveConnection
const clear = () => {
  useStore.getState().tutorConnectionsActions.setConnections([], null)
  useStore.setState((s) => ({ tutorConnections: { ...s.tutorConnections, loaded: false } }))
}

beforeEach(() => {
  backend.reset()
  useStore.getState().preferencesActions.set('tutorActiveConnection', null)
  clear()
})

/** Save each connection in turn (there is no whole-list save). */
const saveAll = async (list: Connection[]) => {
  for (const c of list) await upsertTutorConnection(c)
}

describe('tutor connections (store + ipc)', () => {
  it('starts empty and not loaded', () => {
    expect(slice()).toMatchObject({ list: [], activeId: null, loaded: false })
  })

  it('upsert persists through Rust and load reads it back', async () => {
    await saveAll([claude, local])
    expect(slice().list).toEqual([claude, local])
    expect(backend.ai.connections).toHaveLength(2)
    clear()
    await loadTutorConnections()
    expect(slice()).toMatchObject({ list: [claude, local], loaded: true, activeId: 'c1' })
  })

  it('setActive is stored in the preferences, survives a reload, and ignores an unknown id', async () => {
    await saveAll([claude, local])
    setActiveTutorConnection('c2')
    expect(slice().activeId).toBe('c2')
    expect(pref()).toBe('c2')
    clear()
    await loadTutorConnections()
    expect(slice().activeId).toBe('c2')
    setActiveTutorConnection('nope')
    expect(slice().activeId).toBeNull()
    expect(pref()).toBeNull()
    setActiveTutorConnection('c1')
    setActiveTutorConnection(null)
    expect(slice().activeId).toBeNull()
  })

  it('moves the active connection when it is removed', async () => {
    await saveAll([claude, local])
    setActiveTutorConnection('c2')
    await removeTutorConnection('c2')
    expect(slice().activeId).toBe('c1')
    expect(pref()).toBe('c1')
    await removeTutorConnection('c1')
    expect(slice().activeId).toBeNull()
  })

  it('a rejected upsert leaves the list as it was', async () => {
    await upsertTutorConnection(claude)
    await expect(upsertTutorConnection({ ...local, baseUrl: 'http://h/v1?x=1' })).rejects.toMatchObject({ kind: 'bad_request' })
    expect(slice().list).toEqual([claude])
  })

  it('keeps what Rust stored (a hosted base URL is dropped)', async () => {
    await upsertTutorConnection({ ...claude, baseUrl: 'http://evil/v1' })
    expect(slice().list[0]).not.toHaveProperty('baseUrl')
  })

  it('exposes no secret reader', () => {
    expect(Object.keys(ipc)).not.toContain('getSecret')
  })

  it('upsert and remove change one connection and keep any the store has not seen (T10 I1)', async () => {
    await upsertTutorConnection(claude)
    // Rust adds a connection behind the store's back (a sign-in).
    backend.ai.connections = [...backend.ai.connections, { id: 'or', provider: 'openrouter', label: 'OpenRouter', auth: 'oauth' }]
    backend.ai.secrets.set('or', 'k')
    await upsertTutorConnection({ ...claude, label: 'Claude work' })
    expect(backend.ai.connections.map((c) => [c.id, c.label])).toEqual([['c1', 'Claude work'], ['or', 'OpenRouter']])
    await upsertTutorConnection(local)
    expect(slice().list.map((c) => c.id)).toEqual(['c1', 'or', 'c2'])
    await removeTutorConnection('c1')
    expect(backend.ai.connections.map((c) => c.id)).toEqual(['or', 'c2'])
    expect(backend.ai.secrets.get('or')).toBe('k')
    expect(slice().activeId).toBe('or')
    expect(pref()).toBe('or')
  })
})
