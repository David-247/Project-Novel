import { beforeEach, describe, expect, it, vi } from 'vitest'
import { backend } from '@/test-utils/fake-tauri'
import { useStore } from '@/shared/store'
import * as ipc from './ipc'
import { ACTIVE_CONNECTION_KEY } from './store'
import type { Connection } from './types'

vi.mock('@tauri-apps/api/core', async () => (await import('@/test-utils/fake-tauri')).coreModule)

const claude: Connection = { id: 'c1', provider: 'anthropic', label: 'Claude', auth: 'api_key' }
const local: Connection = { id: 'c2', provider: 'ollama', label: 'Ollama', auth: 'none', baseUrl: 'http://localhost:11434/v1' }

const slice = () => useStore.getState().tutorConnections
const clear = () =>
  useStore.setState((s) => ({ tutorConnections: { ...s.tutorConnections, list: [], activeId: null, loaded: false } }))

beforeEach(() => {
  backend.reset()
  localStorage.clear()
  clear()
})

describe('tutorConnections slice', () => {
  it('starts empty and not loaded', () => {
    expect(slice()).toMatchObject({ list: [], activeId: null, loaded: false })
  })

  it('save persists through Rust and load reads it back', async () => {
    await slice().actions.save([claude, local])
    expect(slice().list).toEqual([claude, local])
    expect(backend.ai.connections).toHaveLength(2)
    clear()
    await slice().actions.load()
    expect(slice()).toMatchObject({ list: [claude, local], loaded: true, activeId: 'c1' })
  })

  it('setActive persists across a reload and ignores an unknown id', async () => {
    await slice().actions.save([claude, local])
    slice().actions.setActive('c2')
    expect(slice().activeId).toBe('c2')
    expect(localStorage.getItem(ACTIVE_CONNECTION_KEY)).toBe('c2')
    clear()
    await slice().actions.load()
    expect(slice().activeId).toBe('c2')
    slice().actions.setActive('nope')
    expect(slice().activeId).toBeNull()
    slice().actions.setActive('c1')
    slice().actions.setActive(null)
    expect(slice().activeId).toBeNull()
  })

  it('moves the active connection when it is removed', async () => {
    await slice().actions.save([claude, local])
    slice().actions.setActive('c2')
    await slice().actions.save([claude])
    expect(slice().activeId).toBe('c1')
    await slice().actions.save([])
    expect(slice().activeId).toBeNull()
  })

  it('a rejected save leaves the list as it was', async () => {
    await slice().actions.save([claude])
    await expect(slice().actions.save([{ ...local, baseUrl: 'http://h/v1?x=1' }])).rejects.toMatchObject({
      kind: 'bad_request',
    })
    expect(slice().list).toEqual([claude])
  })

  it('keeps what Rust stored (a hosted base URL is dropped)', async () => {
    await slice().actions.save([{ ...claude, baseUrl: 'http://evil/v1' }])
    expect(slice().list[0]).not.toHaveProperty('baseUrl')
  })

  it('exposes no secret reader', () => {
    expect(Object.keys(ipc)).not.toContain('getSecret')
    expect(Object.keys(slice().actions)).toEqual(['load', 'save', 'setActive'])
  })
})
