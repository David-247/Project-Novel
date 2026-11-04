import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { contrastRatio, parseSurfaceTokens, parseThemeTokens, SURFACE_CONTRAST_PAIRS, SURFACE_SETS } from '@/shared/theme/contrast'

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
const css = read('src/features/header-footer/header-footer.css').replace(/\/\*[\s\S]*?\*\//g, '')
const themes = parseThemeTokens(read('src/shared/theme/tokens.css'))
const surfaces = parseSurfaceTokens(read('src/shared/theme/surfaces.css'))

/** Declarations of the rules whose selector list contains `selector`. */
const rulesOf = (selector: string) =>
  [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter((m) => m[1].split(',').some((s) => s.trim() === selector)).map((m) => m[2])

describe('dialog preview contrast (every theme x paper surface)', () => {
  it('only the spread is painted with the desk colour; the preview wrapper and captions are not', () => {
    expect(rulesOf('.nv-hf-preview').join(' ')).not.toMatch(/desk-bg|background/)
    expect(rulesOf('.nv-hf-figure figcaption').join(' ')).not.toMatch(/desk-bg|background/)
    expect(rulesOf('.nv-hf-spread').join(' ')).toMatch(/background:\s*var\(--desk-bg\)/)
  })

  it('captions use the theme muted text on the dialog surface: AA in light and dark', () => {
    expect(rulesOf('.nv-hf-figure figcaption').join(' ')).toMatch(/color:\s*var\(--color-text-muted\)/)
    for (const theme of ['light', 'dark'] as const) {
      expect(contrastRatio(themes[theme]['text-muted'], themes[theme]['surface-raised']), theme).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('text inside the mini pages (running heads, numbers) is --page-muted-fg on --page-bg: AA on all four paper sets', () => {
    const pair = SURFACE_CONTRAST_PAIRS.find((p) => p.fg === 'page-muted-fg' && p.bg === 'page-bg')!
    for (const set of SURFACE_SETS) {
      expect(contrastRatio(surfaces[set][pair.fg], surfaces[set][pair.bg]), set).toBeGreaterThanOrEqual(4.5)
    }
  })
})
