import { beforeEach, describe, expect, it, vi } from 'vitest'
import { backend } from '@/test-utils/fake-tauri'
import { useStore } from '@/shared/store'
import * as ipc from './ipc'
import { loadTutorConnections, saveTutorConnections, setActiveTutorConnection } from './store'
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

describe('tutor connections (store + ipc)', () => {
  it('starts empty and not loaded', () => {
    expect(slice()).toMatchObject({ list: [], activeId: null, loaded: false })
  })

  it('save persists through Rust and load reads it back', async () => {
    await saveTutorConnections([claude, local])
    expect(slice().list).toEqual([claude, local])
    expect(backend.ai.connections).toHaveLength(2)
    clear()
    await loadTutorConnections()
    expect(slice()).toMatchObject({ list: [claude, local], loaded: true, activeId: 'c1' })
  })

  it('setActive is stored in the preferences, survives a reload, and ignores an unknown id', async () => {
    await saveTutorConnections([claude, local])
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
    await saveTutorConnections([claude, local])
    setActiveTutorConnection('c2')
    await saveTutorConnections([claude])
    expect(slice().activeId).toBe('c1')
    expect(pref()).toBe('c1')
    await saveTutorConnections([])
    expect(slice().activeId).toBeNull()
  })

  it('a rejected save leaves the list as it was', async () => {
    await saveTutorConnections([claude])
    await expect(saveTutorConnections([{ ...local, baseUrl: 'http://h/v1?x=1' }])).rejects.toMatchObject({ kind: 'bad_request' })
    expect(slice().list).toEqual([claude])
  })

  it('keeps what Rust stored (a hosted base URL is dropped)', async () => {
    await saveTutorConnections([{ ...claude, baseUrl: 'http://evil/v1' }])
    expect(slice().list[0]).not.toHaveProperty('baseUrl')
  })

  it('exposes no secret reader', () => {
    expect(Object.keys(ipc)).not.toContain('getSecret')
  })
})
