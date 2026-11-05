import { describe, expect, it } from 'vitest'
import { contrastRatio } from '@/shared/theme'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8')
const surfacesCss = read('src/shared/theme/surfaces.css')
const css = read('src/features/track-changes/track-changes.css')

/**
 * The track changes marks are non-text graphics (underline, strike, rules, change bars): at least 3:1
 * against each of the four papers (WCAG 2.1 1.4.11). Text keeps the page colour.
 */

const block = (source: string, selector: string) => {
  const s = source.replace(/\/\*[\s\S]*?\*\//g, '')
  const at = s.indexOf(selector)
  if (at < 0) throw new Error(`not found: ${selector}`)
  const body = s.slice(at, s.indexOf('}', at))
  return Object.fromEntries([...body.matchAll(/--([a-z0-9-]+)\s*:\s*(#[0-9a-f]{6})\s*;/gi)].map((m) => [m[1], m[2]]))
}

const papers = {
  white: [":is(:root, .nv-surface-preview)[data-surface='white'] {", ":root[data-surface='white'],"],
  dark: [":is(:root, .nv-surface-preview)[data-surface='dark'] {", ":root[data-surface='dark'] {"],
  'book-light': [":is(:root, .nv-surface-preview)[data-surface='book'] {", ":root[data-surface='book'] {"],
  'book-dark': [":is(:root, .nv-surface-preview)[data-surface='book'][data-theme='dark'] {", ":root[data-surface='book'][data-theme='dark'] {"],
} as const

describe('track changes colours', () => {
  for (const [name, [paperSel, tcSel]] of Object.entries(papers)) {
    it(`reach 3:1 on the ${name} paper`, () => {
      const bg = block(surfacesCss, paperSel)['page-bg']
      const tc = block(css, tcSel)
      expect(Object.keys(tc).sort()).toEqual(['page-tc-del', 'page-tc-fmt', 'page-tc-ins'])
      for (const [token, color] of Object.entries(tc)) expect(contrastRatio(color, bg), `${token} on ${name}`).toBeGreaterThanOrEqual(3)
    })
  }
})
