import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { contrastRatio, parseThemeTokens } from '@/shared/theme'

// The real token file (vitest stubs CSS imports). Tests run from the repo root.
const themes = parseThemeTokens(readFileSync(resolve(process.cwd(), 'src/shared/theme/tokens.css'), 'utf8'))

/**
 * Every colour pair the tutor panel draws (WCAG 2.1 AA: text 4.5:1, icons and control boundaries 3:1),
 * in the light and dark themes. Disabled controls (opacity) are exempt, as WCAG allows; e2e measures the
 * rendered panel too (e2e/tutor.spec.ts).
 */
const PAIRS: { fg: string; bg: string; kind: 'text' | 'graphic'; usage: string }[] = [
  { fg: 'text', bg: 'surface-raised', kind: 'text', usage: 'title, greeting, menus' },
  { fg: 'text', bg: 'surface', kind: 'text', usage: 'composer text, prompts, corrections' },
  { fg: 'text-muted', bg: 'surface-raised', kind: 'text', usage: 'placeholder, model picker, dates' },
  { fg: 'text-muted', bg: 'surface', kind: 'text', usage: 'explanations, activity line, chip counts' },
  { fg: 'text', bg: 'accent-soft', kind: 'text', usage: 'your message bubble' },
  { fg: 'accent', bg: 'accent-soft', kind: 'text', usage: 'the open chat in the history' },
  { fg: 'accent', bg: 'surface', kind: 'text', usage: 'the correction location link' },
  { fg: 'accent', bg: 'surface-raised', kind: 'graphic', usage: 'the sparkle in the title' },
  { fg: 'accent', bg: 'accent-soft', kind: 'graphic', usage: 'the tutor avatar' },
  { fg: 'accent-contrast', bg: 'accent', kind: 'graphic', usage: 'Send and Stop icons' },
  { fg: 'accent-contrast', bg: 'accent', kind: 'text', usage: 'Fix, Allow, Connect' },
  { fg: 'success', bg: 'surface-raised', kind: 'text', usage: '"Fixed"' },
  { fg: 'danger', bg: 'surface-raised', kind: 'text', usage: 'a history error' },
  { fg: 'danger', bg: 'surface', kind: 'graphic', usage: 'the error icon' },
  { fg: 'border-control', bg: 'surface', kind: 'graphic', usage: 'the composer box' },
  { fg: 'accent', bg: 'surface', kind: 'graphic', usage: 'the composer box with the focus' },
  { fg: 'text', bg: 'surface-hover', kind: 'text', usage: 'hovered rows and buttons' },
  { fg: 'text-muted', bg: 'surface-hover', kind: 'text', usage: 'inline code' },
]

describe('tutor panel colours meet WCAG AA', () => {
  for (const theme of ['light', 'dark'] as const) {
    for (const p of PAIRS) {
      const min = p.kind === 'text' ? 4.5 : 3
      it(`${theme}: ${p.fg} on ${p.bg} (${p.usage}) >= ${min}`, () => {
        const fg = themes[theme][p.fg]
        const bg = themes[theme][p.bg]
        expect(fg, `--nv-${p.fg}`).toBeDefined()
        expect(bg, `--nv-${p.bg}`).toBeDefined()
        expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(min)
      })
    }
  }
})
