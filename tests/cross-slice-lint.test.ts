// @vitest-environment node
import { readdirSync } from 'node:fs'
import { ESLint } from 'eslint'
import { describe, expect, it } from 'vitest'
// @ts-expect-error -- the flat config is plain JS with no declaration file
import { SLICES } from '../eslint.config.js'

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
  it('the export slice is covered: a deep import into settings is rejected, its index is fine', async () => {
    expect(await messages('tests/fixtures/features/export/bad-deep-import.ts')).toHaveLength(1)
    expect(await messages('tests/fixtures/features/export/good-index-import.ts')).toHaveLength(0)
    expect(await messages('tests/fixtures/features/export/bad-relative-import.ts')).toHaveLength(1)
  })
  it('the outline slice is covered both ways: it reaches others by their index, others reach it by its index', async () => {
    expect(await messages('tests/fixtures/features/outline/bad-deep-import.ts')).toHaveLength(1)
    expect(await messages('tests/fixtures/features/outline/good-index-import.ts')).toHaveLength(0)
    expect(await messages('tests/fixtures/features/editor/bad-outline-deep-import.ts')).toHaveLength(1)
  })
  it('every folder of src/features is a slice of the rule (a new slice cannot be missed)', () => {
    const folders = readdirSync('src/features', { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
    expect([...(SLICES as string[])].sort()).toEqual(folders.sort())
  })
  it('the ribbon slice is covered: a deep import into it is rejected, its index is fine', async () => {
    expect(await messages('tests/fixtures/features/editor/bad-ribbon-deep-import.ts')).toHaveLength(1)
    expect(await messages('tests/fixtures/features/editor/good-ribbon-index-import.ts')).toHaveLength(0)
  })
  it("a slice's own sub-folder named like another slice (export/settings) is not a cross-slice import", async () => {
    expect(await messages('tests/fixtures/features/export/good-own-subfolder.ts')).toHaveLength(0)
  })
})
