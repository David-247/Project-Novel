// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const DIR = join(__dirname, '..', '.github', 'workflows')

describe('CI workflow files', () => {
  it.each(readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f)))('%s ends with a newline', (file) => {
    expect(readFileSync(join(DIR, file), 'utf8').endsWith('\n')).toBe(true)
  })
})
