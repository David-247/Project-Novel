// @vitest-environment node
import { ESLint } from 'eslint'
import { describe, expect, it } from 'vitest'

// ignore:false because the fixtures dir is excluded from the normal `pnpm lint` run.
const eslint = new ESLint({ ignore: false })

async function messages(file: string) {
  const [res] = await eslint.lintFiles([file])
  return res.messages.filter((m) => m.ruleId === 'no-restricted-imports')
}

// ESLint startup is slow under a loaded parallel run; the 5 s default flaked.
describe('cross-slice import rule', { timeout: 30_000 }, () => {
  it('rejects alias deep import into another slice', async () => {
    expect(await messages('tests/fixtures/features/editor/bad-deep-import.ts')).toHaveLength(1)
  })
  it('rejects relative deep import into another slice', async () => {
    expect(await messages('tests/fixtures/features/editor/bad-relative-import.ts')).toHaveLength(1)
  })
  it('allows import via the slice index', async () => {
    expect(await messages('tests/fixtures/features/editor/good-index-import.ts')).toHaveLength(0)
  })
})
