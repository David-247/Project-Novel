import { describe, expect, it } from 'vitest'
import { baseUrlHint, baseUrlProblem, isLoopbackHost, needsInsecureConfirm, normaliseBaseUrl, originOf } from './url'

describe('settings address checks', () => {
  it('loopback is localhost and loopback IP literals only (R8)', () => {
    for (const h of ['localhost', 'LOCALHOST', 'localhost.', '127.0.0.1', '127.1.2.3', '[::1]', '::1']) expect(isLoopbackHost(h), h).toBe(true)
    for (const h of ['foo.localhost', 'localhost.example.com', '127.0.0.1.nip.io', '192.168.1.5', '[::ffff:192.168.1.5]', '128.0.0.1', '127.0.0.256', 'nas.local'])
      expect(isLoopbackHost(h), h).toBe(false)
  })

  it('asks before plain http to another computer, never for https or this computer', () => {
    for (const u of ['http://192.168.1.20:11434/v1', 'http://nas.local/v1', 'http://foo.localhost:1234', 'http://example.com/v1']) expect(needsInsecureConfirm(u), u).toBe(true)
    for (const u of ['https://192.168.1.20/v1', 'http://localhost:11434/v1', 'http://127.0.0.1:1234/v1', 'http://[::1]:8080', 'not a url']) expect(needsInsecureConfirm(u), u).toBe(false)
    expect(originOf('http://192.168.1.20:11434/v1')).toBe('http://192.168.1.20:11434')
  })

  it('mirrors the Rust address rules', () => {
    for (const bad of ['', 'host/v1', 'ftp://h/v1', 'http://u:p@h/v1', 'http://h/v1?k=1', 'http://h/v1#x', 'http://h /v1']) expect(baseUrlProblem(bad), bad).not.toBeNull()
    for (const good of ['http://localhost:11434', 'https://llm.example.com/v1']) expect(baseUrlProblem(good), good).toBeNull()
  })

  it("adds a local server's API path (Ollama, LM Studio: /v1), and hints for a custom address without one (T3)", () => {
    expect(normaliseBaseUrl('/v1', ' http://localhost:11434 ')).toBe('http://localhost:11434/v1')
    expect(normaliseBaseUrl('/v1', 'http://localhost:1234/')).toBe('http://localhost:1234/v1')
    expect(normaliseBaseUrl('/v1', 'http://localhost:11434/v1/')).toBe('http://localhost:11434/v1')
    expect(normaliseBaseUrl(undefined, 'https://llm.example.com/')).toBe('https://llm.example.com')
    expect(normaliseBaseUrl(undefined, 'nonsense')).toBe('nonsense')
    expect(baseUrlHint(undefined, 'https://llm.example.com')).toMatch(/\/v1/)
    expect(baseUrlHint(undefined, 'https://llm.example.com/v1')).toBeNull()
    expect(baseUrlHint(undefined, 'https://llm.example.com/api/v4/')).toBeNull()
    expect(baseUrlHint('/v1', 'http://localhost:11434')).toBeNull()
  })
})
