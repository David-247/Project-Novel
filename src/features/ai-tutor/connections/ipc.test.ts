import { beforeEach, describe, expect, it, vi } from 'vitest'
import { backend } from '@/test-utils/fake-tauri'
import * as ipc from './ipc'

vi.mock('@tauri-apps/api/core', async () => (await import('@/test-utils/fake-tauri')).coreModule)

beforeEach(() => backend.reset())

describe('connection ipc', () => {
  it('has no way to read a secret back', () => {
    expect(Object.keys(ipc)).not.toContain('getSecret')
    expect(Object.keys(ipc).sort()).toEqual(['deleteSecret', 'getConnections', 'hasSecret', 'saveConnections', 'setSecret'])
  })

  it('stores, reports and deletes a secret in the (fake) keychain', async () => {
    expect(await ipc.hasSecret('c1')).toBe(false)
    await ipc.setSecret('c1', 'sk-1')
    expect(await ipc.hasSecret('c1')).toBe(true)
    expect(backend.ai.secrets.get('c1')).toBe('sk-1')
    await ipc.deleteSecret('c1')
    expect(await ipc.hasSecret('c1')).toBe(false)
  })

  it('never puts the secret in the connections file', async () => {
    await ipc.saveConnections([{ id: 'c1', provider: 'anthropic', label: 'Claude', auth: 'api_key' }])
    await ipc.setSecret('c1', 'sk-ant-SECRET')
    expect(JSON.stringify(await ipc.getConnections())).not.toContain('SECRET')
  })

  it('rejects a bad base URL on save, like Rust', async () => {
    for (const baseUrl of ['http://h/v1?k=1', 'http://h/v1#f', 'http://u:p@h/v1', 'ftp://h/v1', 'nope']) {
      await expect(
        ipc.saveConnections([{ id: 'c1', provider: 'custom', label: 'x', auth: 'none', baseUrl }]),
      ).rejects.toMatchObject({ kind: 'bad_request' })
    }
    expect(await ipc.getConnections()).toEqual([])
  })

  it('drops a hosted provider base URL and the secret of a removed connection', async () => {
    await ipc.saveConnections([{ id: 'c1', provider: 'openai', label: 'x', auth: 'api_key', baseUrl: 'http://evil/v1' }])
    expect((await ipc.getConnections())[0]).not.toHaveProperty('baseUrl')
    await ipc.setSecret('c1', 'k')
    await ipc.saveConnections([])
    expect(await ipc.hasSecret('c1')).toBe(false)
  })
})
