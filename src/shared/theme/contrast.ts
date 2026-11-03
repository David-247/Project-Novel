/** WCAG 2.1 contrast helpers (used by the token contrast test and available to tooling). */

export function parseHex(hex: string): [number, number, number] {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) throw new Error(`Expected #rrggbb, got "${hex}"`)
  const n = parseInt(m[1], 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

export function relativeLuminance(hex: string): number {
  const [r, g, b] = parseHex(hex).map((c) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  const [hi, lo] = la > lb ? [la, lb] : [lb, la]
  return (hi + 0.05) / (lo + 0.05)
}

export type ThemeName = 'light' | 'dark'
export type ThemeTokens = Record<string, string>

/**
 * Extracts `--nv-*` declarations for each theme from tokens.css source.
 * Light = the `:root, :root[data-theme='light']` block; dark = `:root[data-theme='dark']`.
 */
export function parseThemeTokens(css: string): Record<ThemeName, ThemeTokens> {
  const block = (selectorRe: RegExp): ThemeTokens => {
    const m = selectorRe.exec(css)
    if (!m) throw new Error(`Theme block not found: ${selectorRe}`)
    const body = m[1].replace(/\/\*[\s\S]*?\*\//g, '')
    const out: ThemeTokens = {}
    for (const d of body.matchAll(/--nv-([a-z0-9-]+)\s*:\s*([^;]+);/g)) out[d[1]] = d[2].trim()
    return out
  }
  return {
    light: block(/:root\[data-theme='light'\]\s*\{([^}]*)\}/),
    dark: block(/:root\[data-theme='dark'\]\s*\{([^}]*)\}/),
  }
}

export interface ContrastPair {
  fg: string
  bg: string
  /** 'text' requires 4.5:1 (WCAG 1.4.3); 'ui' requires 3:1 (WCAG 1.4.11, control boundaries/focus). */
  kind: 'text' | 'ui'
  usage: string
}

const PLANES = ['bg', 'surface', 'surface-raised'] as const

/** Every foreground/background token pairing the UI primitives actually render. */
export const CONTRAST_PAIRS: ContrastPair[] = [
  ...PLANES.flatMap((bg): ContrastPair[] => [
    { fg: 'text', bg, kind: 'text', usage: 'body and control labels' },
    { fg: 'text-muted', bg, kind: 'text', usage: 'secondary text, status bar' },
    { fg: 'accent', bg, kind: 'text', usage: 'links, accent text' },
    { fg: 'danger', bg, kind: 'text', usage: 'error text' },
    { fg: 'warning', bg, kind: 'text', usage: 'warning text' },
    { fg: 'success', bg, kind: 'text', usage: 'success text' },
    { fg: 'border-control', bg, kind: 'ui', usage: 'input/select/checkbox outline' },
    { fg: 'focus-ring', bg, kind: 'ui', usage: 'keyboard focus ring' },
    { fg: 'accent', bg, kind: 'ui', usage: 'primary button fill, checked checkbox' },
    { fg: 'danger', bg, kind: 'ui', usage: 'danger button fill' },
    { fg: 'danger-hover', bg, kind: 'ui', usage: 'danger button fill, hovered' },
  ]),
  { fg: 'border-control', bg: 'surface-hover', kind: 'ui', usage: 'secondary button outline, hovered' },
  { fg: 'danger-contrast', bg: 'danger-hover', kind: 'text', usage: 'danger button label, hovered' },
  { fg: 'danger-hover', bg: 'surface-hover', kind: 'ui', usage: 'danger button fill over hover plane' },
  { fg: 'text', bg: 'surface-hover', kind: 'text', usage: 'hovered quiet control' },
  { fg: 'text-muted', bg: 'surface-hover', kind: 'text', usage: 'hovered icon button' },
  { fg: 'accent-contrast', bg: 'accent', kind: 'text', usage: 'primary button label' },
  { fg: 'accent-contrast', bg: 'accent-hover', kind: 'text', usage: 'primary button hovered' },
  { fg: 'accent', bg: 'accent-soft', kind: 'text', usage: 'pressed toggle button' },
  { fg: 'text', bg: 'accent-soft', kind: 'text', usage: 'text selection' },
  { fg: 'danger-contrast', bg: 'danger', kind: 'text', usage: 'danger button label' },
  { fg: 'accent', bg: 'surface-hover', kind: 'ui', usage: 'pressed toggle indicator on hover' },
  { fg: 'focus-ring', bg: 'surface-hover', kind: 'ui', usage: 'focus ring on hovered control' },
]

/** The four concrete paper token sets: book has a warm light and a warm dark variant. */
export type SurfaceSet = 'white' | 'dark' | 'book-light' | 'book-dark'
export const SURFACE_SETS: readonly SurfaceSet[] = ['white', 'dark', 'book-light', 'book-dark']

/** Which concrete set `data-surface` + `data-theme` select (mirrors surfaces.css). */
export function surfaceSetFor(surface: 'white' | 'dark' | 'book', theme: ThemeName): SurfaceSet {
  return surface === 'book' ? (theme === 'dark' ? 'book-dark' : 'book-light') : surface
}

/**
 * Extracts the colour (6-digit hex) `--*` declarations of each paper surface from surfaces.css
 * source. Shadows and textures are decorative and skipped.
 */
export function parseSurfaceTokens(css: string): Record<SurfaceSet, ThemeTokens> {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const find = (selector: string): ThemeTokens => {
    const at = stripped.indexOf(`${selector} {`)
    if (at < 0) throw new Error(`Surface block not found: ${selector}`)
    const body = stripped.slice(at, stripped.indexOf('}', at))
    const out: ThemeTokens = {}
    for (const d of body.matchAll(/--([a-z0-9-]+)\s*:\s*(#[0-9a-f]{6})\s*;/gi)) out[d[1]] = d[2]
    return out
  }
  const head = ':is(:root, .nv-surface-preview)'
  return {
    white: find(`${head}[data-surface='white']`),
    dark: find(`${head}[data-surface='dark']`),
    'book-light': find(`${head}[data-surface='book']`),
    'book-dark': find(`${head}[data-surface='book'][data-theme='dark']`),
  }
}

/** Foreground/background pairs inside one paper surface (token names without `--`). */
export const SURFACE_CONTRAST_PAIRS: ContrastPair[] = [
  { fg: 'page-fg', bg: 'page-bg', kind: 'text', usage: 'body text on the page' },
  { fg: 'page-muted-fg', bg: 'page-bg', kind: 'text', usage: 'page numbers, running heads, footnote text' },
  { fg: 'page-fg', bg: 'page-selection-bg', kind: 'text', usage: 'selected text' },
  { fg: 'page-fg', bg: 'page-find-bg', kind: 'text', usage: 'find match' },
  { fg: 'page-fg', bg: 'page-find-current-bg', kind: 'text', usage: 'current find match' },
  { fg: 'page-find-ring', bg: 'page-bg', kind: 'ui', usage: 'current-match outline on the page' },
  { fg: 'page-find-ring', bg: 'page-find-current-bg', kind: 'ui', usage: 'current-match outline against its own fill' },
  { fg: 'page-focus-ring', bg: 'desk-bg', kind: 'ui', usage: 'focus outline around the page, on the desk' },
  { fg: 'page-focus-ring', bg: 'page-bg', kind: 'ui', usage: 'focus outline, page side' },
]
