import { beforeEach, describe, expect, it, vi } from 'vitest'
import { backend } from '@/test-utils/fake-tauri'
import * as ipc from './ipc'
import type { Connection } from './types'

vi.mock('@tauri-apps/api/core', async () => (await import('@/test-utils/fake-tauri')).coreModule)

beforeEach(() => backend.reset())

describe('connection ipc', () => {
  it('has no way to read a secret back, and no whole-list save', () => {
    expect(Object.keys(ipc)).not.toContain('getSecret')
    expect(Object.keys(ipc)).not.toContain('saveConnections')
    expect(Object.keys(ipc).sort()).toEqual(['deleteSecret', 'getConnections', 'hasSecret', 'removeConnection', 'setSecret', 'upsertConnection'])
  })

  it('stores, reports and deletes a secret in the (fake) keychain', async () => {
    await ipc.upsertConnection({ id: 'c1', provider: 'openai', label: 'x', auth: 'api_key' })
    expect(await ipc.hasSecret('c1')).toBe(false)
    await ipc.setSecret('c1', 'sk-1')
    expect(await ipc.hasSecret('c1')).toBe(true)
    expect(backend.ai.secrets.get('c1')).toBe('sk-1')
    await ipc.deleteSecret('c1')
    expect(await ipc.hasSecret('c1')).toBe(false)
  })

  it('never puts the secret in the connections file', async () => {
    await ipc.upsertConnection({ id: 'c1', provider: 'anthropic', label: 'Claude', auth: 'api_key' })
    await ipc.setSecret('c1', 'sk-ant-SECRET')
    expect(JSON.stringify(await ipc.getConnections())).not.toContain('SECRET')
  })

  it('rejects a bad base URL on save, like Rust', async () => {
    for (const baseUrl of ['http://h/v1?k=1', 'http://h/v1#f', 'http://u:p@h/v1', 'ftp://h/v1', 'nope']) {
      await expect(
        ipc.upsertConnection({ id: 'c1', provider: 'custom', label: 'x', auth: 'none', baseUrl }),
      ).rejects.toMatchObject({ kind: 'bad_request' })
    }
    expect(await ipc.getConnections()).toEqual([])
  })

  it('drops a hosted provider base URL and the secret of a removed connection', async () => {
    await ipc.upsertConnection({ id: 'c1', provider: 'openai', label: 'x', auth: 'api_key', baseUrl: 'http://evil/v1' })
    expect((await ipc.getConnections())[0]).not.toHaveProperty('baseUrl')
    await ipc.setSecret('c1', 'k')
    await ipc.removeConnection('c1')
    expect(await ipc.hasSecret('c1')).toBe(false)
  })

  it('refuses a secret for a connection that is not saved', async () => {
    await expect(ipc.setSecret('c1', 'k')).rejects.toMatchObject({ kind: 'not_connected' })
  })

  describe('a stored key does not follow a re-pointed connection (like Rust)', () => {
    const base: Connection = { id: 'c1', provider: 'custom', label: 'x', auth: 'api_key', baseUrl: 'https://llm.example.com/v1' }
    const changes: [string, Partial<Connection>][] = [
      ['provider', { provider: 'ollama' }],
      ['auth', { auth: 'oauth' }],
      ['host', { baseUrl: 'https://attacker.example/v1' }],
      ['scheme', { baseUrl: 'http://llm.example.com/v1' }],
      ['port', { baseUrl: 'https://llm.example.com:8443/v1' }],
    ]
    it.each(changes)('deletes the secret when the %s changes', async (_name, change) => {
      await ipc.upsertConnection(base)
      await ipc.setSecret('c1', 'sk-live')
      await ipc.upsertConnection({ ...base, ...change })
      expect(await ipc.hasSecret('c1')).toBe(false)
    })

    it('a hosted connection saved as a custom one loses its key', async () => {
      await ipc.upsertConnection({ id: 'c1', provider: 'anthropic', label: 'x', auth: 'api_key' })
      await ipc.setSecret('c1', 'sk-ant')
      await ipc.upsertConnection({ ...base, baseUrl: 'https://attacker.example' })
      expect(backend.ai.secrets.has('c1')).toBe(false)
    })

    it('keeps the secret when only the label, model or path changes', async () => {
      await ipc.upsertConnection(base)
      await ipc.setSecret('c1', 'sk-live')
      await ipc.upsertConnection({ ...base, label: 'renamed', defaultModel: 'm', baseUrl: 'https://LLM.example.com:443/other/' })
      expect(await ipc.hasSecret('c1')).toBe(true)
    })
  })
})
