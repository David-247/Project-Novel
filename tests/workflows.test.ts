// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const DIR = join(__dirname, '..', '.github', 'workflows')

describe('CI workflow files', () => {
  it.each(readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f)))('%s ends with a newline', (file) => {
    expect(readFileSync(join(DIR, file), 'utf8').endsWith('\n')).toBe(true)
  })

  it('the release check looks for the licence texts in the built app on both platforms, and caches its sidecar apart from CI', () => {
    const release = readFileSync(join(DIR, 'release.yml'), 'utf8')
    expect(release).toContain('Contents/Resources/licenses/typst-NOTICE.txt')
    expect(release).toContain('target/release/licenses/typst-NOTICE.txt')
    expect(release).toContain('key: sidecar-release-${{ matrix.sidecar-target }}-')
  })
})
