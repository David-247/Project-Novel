// @vitest-environment node
import { describe, expect, it } from 'vitest'

// scripts/fetch-typst.mjs (run before cargo in CI and dev); loaded untyped here.
const SCRIPT: string = '../scripts/fetch-typst.mjs'
const { TYPST_VERSION, TYPST_ASSETS, FONTS, sidecarName } = (await import(/* @vite-ignore */ SCRIPT)) as {
  TYPST_VERSION: string
  TYPST_ASSETS: Record<string, { file: string; sha256: string }>
  FONTS: { sha256: string; files: string[] }
  sidecarName: (triple: string) => string
}

describe('Typst sidecar fetch script', () => {
  it('pins one version with a SHA-256 for every shipping target', () => {
    expect(TYPST_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
    for (const triple of ['x86_64-pc-windows-msvc', 'aarch64-apple-darwin', 'x86_64-apple-darwin']) {
      expect(TYPST_ASSETS[triple]?.sha256).toMatch(/^[0-9a-f]{64}$/)
    }
    expect(FONTS.sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('bundles the serif and mono fallbacks in all four styles', () => {
    for (const family of ['LiberationSerif', 'LiberationMono']) {
      for (const style of ['Regular', 'Bold', 'Italic', 'BoldItalic']) expect(FONTS.files).toContain(`${family}-${style}.ttf`)
    }
  })

  it('names sidecars the way Tauri externalBin expects', () => {
    expect(sidecarName('x86_64-pc-windows-msvc')).toBe('typst-x86_64-pc-windows-msvc.exe')
    expect(sidecarName('universal-apple-darwin')).toBe('typst-universal-apple-darwin')
  })
})
