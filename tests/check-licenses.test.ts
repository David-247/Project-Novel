// @vitest-environment node
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
