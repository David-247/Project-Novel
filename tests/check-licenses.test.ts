// @vitest-environment node
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// The gate is a plain Node script (scripts/check-licenses.mjs, run in CI); loaded untyped here.
const SCRIPT: string = '../scripts/check-licenses.mjs'
const { allowedExpression } = (await import(/* @vite-ignore */ SCRIPT)) as { allowedExpression: (e: string) => boolean }

describe('license gate (SPDX expressions)', () => {
  it.each(['MIT', 'ISC', 'Apache-2.0', 'MPL-2.0', 'BSD-3-Clause', '0BSD', 'MIT OR Apache-2.0', '(MIT OR GPL-3.0)', 'MIT AND ISC'])(
    'allows %s',
    (expr) => expect(allowedExpression(expr)).toBe(true),
  )

  it.each(['GPL-3.0', 'AGPL-3.0-only', 'LGPL-2.1', 'MIT AND GPL-2.0', 'GPL-2.0 WITH Classpath-exception-2.0', 'UNKNOWN', 'SEE LICENSE IN LICENSE.txt', ''])(
    'rejects %s',
    (expr) => expect(allowedExpression(expr)).toBe(false),
  )
})

interface Bundled {
  name: string
  version: string
  license: string
  externalBin?: string
  resources?: string
  texts: string[]
}
const { checkBundled, BUNDLED } = (await import(/* @vite-ignore */ SCRIPT)) as {
  checkBundled: (root: string, bundled?: Bundled[]) => string[]
  BUNDLED: Bundled[]
}
const ROOT = join(__dirname, '..')

describe('license gate (bundled sidecar and fonts)', () => {
  it('passes for the files the app bundles', () => {
    expect(checkBundled(ROOT)).toEqual([])
    expect(BUNDLED[0].license).toBe('Apache-2.0 AND LPPL-1.3c')
    // Each licence of the expression ships its full text (LPPL-1.3c: a standalone copy, T3).
    expect(BUNDLED[0].texts).toContain('lppl-1.3c.txt')
  })

  it('allows LPPL-1.3c only for bundled files, never for packages', () => {
    expect(allowedExpression('LPPL-1.3c')).toBe(false)
    expect(allowedExpression('Apache-2.0 AND LPPL-1.3c')).toBe(false)
    const [typst, fonts] = BUNDLED
    expect(checkBundled(ROOT, [{ ...typst, license: 'Apache-2.0 AND GPL-3.0' }, fonts])).toContain(
      'Typst CLI: licence Apache-2.0 AND GPL-3.0 is not allowed',
    )
  })

  it('fails for a disallowed licence, a missing text, or a bundled file with no entry', () => {
    const [typst, fonts] = BUNDLED
    expect(checkBundled(ROOT, [{ ...typst, license: 'GPL-3.0' }, fonts])).toContain('Typst CLI: licence GPL-3.0 is not allowed')
    expect(checkBundled(ROOT, [{ ...typst, texts: ['nope.txt'] }, fonts])).toContain('Typst CLI: missing licence text nope.txt')
    expect(checkBundled(ROOT, [typst, { ...fonts, version: '9.9' }])).toContain('Liberation Fonts 9.9 is not in THIRD_PARTY_LICENSES.md')
    expect(checkBundled(ROOT, [fonts])).toContain('externalBin binaries/typst has no licence entry')
    expect(checkBundled(ROOT, [typst])).toContain('resource resources/fonts/ has no licence entry')
  })
})
