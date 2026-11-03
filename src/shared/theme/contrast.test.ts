import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CONTRAST_PAIRS, contrastRatio, parseThemeTokens } from './contrast'

// Read the real token file from disk (vitest stubs CSS imports by default). Tests run from the repo root.
const css = readFileSync(resolve(process.cwd(), 'src/shared/theme/tokens.css'), 'utf8')

const themes = parseThemeTokens(css)

describe('contrast helpers', () => {
  it('matches known WCAG ratios', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5)
    expect(contrastRatio('#777777', '#ffffff')).toBeCloseTo(4.48, 2)
  })
})

describe('theme tokens', () => {
  it('light and dark declare the same token names', () => {
    expect(Object.keys(themes.dark).sort()).toEqual(Object.keys(themes.light).sort())
  })

  for (const name of ['light', 'dark'] as const) {
    describe(`${name} theme meets WCAG AA`, () => {
      for (const p of CONTRAST_PAIRS) {
        const min = p.kind === 'text' ? 4.5 : 3
        it(`${p.fg} on ${p.bg} (${p.kind}, ${p.usage}) >= ${min}`, () => {
          const fg = themes[name][p.fg]
          const bg = themes[name][p.bg]
          expect(fg, `--nv-${p.fg} missing`).toBeDefined()
          expect(bg, `--nv-${p.bg} missing`).toBeDefined()
          expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(min)
        })
      }
    })
  }
})
