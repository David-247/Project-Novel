// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { pickSidecar } from './test-harness'

describe('pickSidecar: the host-architecture Typst', () => {
  const mac = ['typst-aarch64-apple-darwin', 'typst-x86_64-apple-darwin', 'typst-universal-apple-darwin']

  it('an Intel Mac takes the x86_64 build, never the arm64 one that sorts first', () => {
    expect(pickSidecar(mac, 'darwin', 'x64')).toBe('typst-x86_64-apple-darwin')
    expect(pickSidecar(['typst-aarch64-apple-darwin', 'typst-universal-apple-darwin'], 'darwin', 'x64')).toBe('typst-universal-apple-darwin')
    expect(pickSidecar(['typst-aarch64-apple-darwin'], 'darwin', 'x64')).toBeNull()
  })
  it('an Apple silicon Mac takes the aarch64 build, else the universal one', () => {
    expect(pickSidecar(mac, 'darwin', 'arm64')).toBe('typst-aarch64-apple-darwin')
    expect(pickSidecar(['typst-universal-apple-darwin'], 'darwin', 'arm64')).toBe('typst-universal-apple-darwin')
  })
  it('Windows takes the .exe of its own architecture', () => {
    expect(pickSidecar(['typst-x86_64-pc-windows-msvc.exe'], 'win32', 'x64')).toBe('typst-x86_64-pc-windows-msvc.exe')
    expect(pickSidecar([], 'win32', 'x64')).toBeNull()
  })
})
