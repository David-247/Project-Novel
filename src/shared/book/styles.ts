// Paragraph and chapter styles (Phase 2, styles ticket). Pure data + functions; no slice imports.
//
// Storage shape: `book.styles` (StyleSheetJSON) holds ONLY what the user changed:
//  - for a built-in id: a partial override (keys equal to the built-in value are dropped;
//    `null` means "explicitly unset / inherit" where the built-in sets a value);
//  - for a custom id: the full definition (`builtIn: false`).
// Unknown keys are preserved on every write. `{}` = all built-ins at their defaults.
// Built-ins are merged with the overrides at read time (`resolveStyleSheet`); nothing is migrated.
//
// Units (book points so a style means the same thing on screen and on the page):
//  fontSize, spaceBefore, spaceAfter: points. Rendered as `calc(N * var(--nv-pt, 1pt))`, so the
//    surface decides how big a book point is (see BOOK_POINT_VAR).
//  firstLineIndent, indentLeft, indentRight, letterSpacing: em. lineHeight: unitless multiple.

import type { StyleSheetJSON } from './index'

export type StyleKind = 'paragraph' | 'chapter'
export type BreakBefore = 'none' | 'page' | 'recto'
export type StyleAlign = 'left' | 'center' | 'right' | 'justify'
export type StyleTextTransform = 'none' | 'uppercase' | 'lowercase' | 'capitalize' | 'small-caps'

/** Formatting properties: inherited through `basedOn`, rendered as CSS. */
export interface StyleFormat {
  fontFamily?: string
  fontSize?: number
  fontWeight?: number
  italic?: boolean
  align?: StyleAlign
  lineHeight?: number
  spaceBefore?: number
  spaceAfter?: number
  firstLineIndent?: number
  indentLeft?: number
  indentRight?: number
  textTransform?: StyleTextTransform
  letterSpacing?: number
  breakBefore?: BreakBefore
}

export interface StyleDef extends StyleFormat {
  name: string
  /** Parent style id: unset formatting properties come from it. */
  basedOn?: string
  /** 'chapter' styles are headings in the document (outline, chapter openings); 'paragraph' styles are paragraphs. */
  kind: StyleKind
  /** Heading level used when a chapter style is applied (default 1). Ignored for paragraph styles. */
  outlineLevel?: 1 | 2 | 3
  /** Style of the paragraph created by Enter at the end of a block of this style (default: the same style). */
  nextStyle?: string
  builtIn: boolean
}

/** A style with every formatting property resolved through its `basedOn` chain. */
export interface ResolvedStyle extends StyleDef {
  id: string
}

export type ResolvedStyles = ReadonlyMap<string, ResolvedStyle>

export const FORMAT_KEYS = [
  'fontFamily',
  'fontSize',
  'fontWeight',
  'italic',
  'align',
  'lineHeight',
  'spaceBefore',
  'spaceAfter',
  'firstLineIndent',
  'indentLeft',
  'indentRight',
  'textTransform',
  'letterSpacing',
  'breakBefore',
] as const satisfies ReadonlyArray<keyof StyleFormat>

const DEF_KEYS = ['name', 'basedOn', 'kind', 'outlineLevel', 'nextStyle', ...FORMAT_KEYS] as const

/** CSS custom property holding the length of one book point on the current surface. */
export const BOOK_POINT_VAR = '--nv-pt'

/** Well-known built-in ids. */
export const STYLE_IDS = {
  body: 'body',
  firstParagraph: 'first-paragraph',
  chapterNumber: 'chapter-number',
  chapterTitle: 'chapter-title',
  partTitle: 'part-title',
  subheading: 'subheading',
  sceneBreak: 'scene-break',
  blockQuote: 'block-quote',
  epigraph: 'epigraph',
  dedication: 'dedication',
} as const

export const DEFAULT_STYLE_ID = STYLE_IDS.body

type BuiltInDef = Omit<StyleDef, 'builtIn'>

/**
 * Built-in styles, in picker order. Book-typography defaults (sizes for an 11 pt text face):
 * - Body: 11/16.5 pt, ragged right, 1.5 em first-line indent, no space between paragraphs.
 * - First Paragraph: Body without the indent (after headings and scene breaks).
 * - Chapter Number: small caps 12 pt, centered, spaced; starts a page; followed by Chapter Title.
 * - Chapter Title: 20 pt centered, 72 pt sink; starts a page (switch to 'recto' to open on the right).
 * - Part Title: 24 pt uppercase, 144 pt sink; starts a right-hand (recto) page.
 * - Subheading: 13 pt semibold, flush left (Phase 1 H2/H3 map here).
 * - Scene Break: centered, no indent, 12 pt above and below (type "* * *" or a glyph).
 * - Block Quote: 10 pt, indented 2 em both sides, 6 pt above and below.
 * - Epigraph: 10 pt italic, indented 4 em on the left.
 * - Dedication: italic, centered, 144 pt sink; starts a right-hand page.
 */
const BUILT_INS = new Map<string, BuiltInDef>()

/**
 * Registers a built-in style (one line per style, e.g. the running head or footnote text from
 * later tickets): `registerBuiltInStyle('running-head', { name: 'Running Head', kind: 'paragraph', basedOn: 'body', fontSize: 9 })`.
 * Call at module load, before the styles are first read. Re-registering an id replaces it.
 */
export function registerBuiltInStyle(id: string, def: BuiltInDef): void {
  BUILT_INS.set(id, { ...def })
  registryVersion++
}

let registryVersion = 0
/** Changes whenever a built-in is registered (memo key). */
export function builtInRegistryVersion(): number {
  return registryVersion
}

registerBuiltInStyle(STYLE_IDS.body, {
  name: 'Body', kind: 'paragraph', fontSize: 11, fontWeight: 400, italic: false, align: 'left', lineHeight: 1.5,
  spaceBefore: 0, spaceAfter: 0, firstLineIndent: 1.5, indentLeft: 0, indentRight: 0, textTransform: 'none',
  letterSpacing: 0, breakBefore: 'none',
})
registerBuiltInStyle(STYLE_IDS.firstParagraph, {
  name: 'First Paragraph', kind: 'paragraph', basedOn: STYLE_IDS.body, firstLineIndent: 0, nextStyle: STYLE_IDS.body,
})
registerBuiltInStyle(STYLE_IDS.chapterNumber, {
  name: 'Chapter Number', kind: 'chapter', basedOn: STYLE_IDS.body, outlineLevel: 1, fontSize: 12, align: 'center',
  lineHeight: 1.2, textTransform: 'small-caps', letterSpacing: 0.12, firstLineIndent: 0, spaceBefore: 72, spaceAfter: 6,
  breakBefore: 'page', nextStyle: STYLE_IDS.chapterTitle,
})
registerBuiltInStyle(STYLE_IDS.chapterTitle, {
  name: 'Chapter Title', kind: 'chapter', basedOn: STYLE_IDS.body, outlineLevel: 1, fontSize: 20, align: 'center',
  lineHeight: 1.2, firstLineIndent: 0, spaceBefore: 72, spaceAfter: 36, breakBefore: 'page', nextStyle: STYLE_IDS.firstParagraph,
})
registerBuiltInStyle(STYLE_IDS.partTitle, {
  name: 'Part Title', kind: 'chapter', basedOn: STYLE_IDS.body, outlineLevel: 1, fontSize: 24, align: 'center',
  lineHeight: 1.2, textTransform: 'uppercase', letterSpacing: 0.1, firstLineIndent: 0, spaceBefore: 144, spaceAfter: 36,
  breakBefore: 'recto', nextStyle: STYLE_IDS.firstParagraph,
})
registerBuiltInStyle(STYLE_IDS.subheading, {
  name: 'Subheading', kind: 'chapter', basedOn: STYLE_IDS.body, outlineLevel: 2, fontSize: 13, fontWeight: 600,
  lineHeight: 1.3, firstLineIndent: 0, spaceBefore: 18, spaceAfter: 6, nextStyle: STYLE_IDS.firstParagraph,
})
registerBuiltInStyle(STYLE_IDS.sceneBreak, {
  name: 'Scene Break', kind: 'paragraph', basedOn: STYLE_IDS.body, align: 'center', firstLineIndent: 0,
  spaceBefore: 12, spaceAfter: 12, letterSpacing: 0.5, nextStyle: STYLE_IDS.firstParagraph,
})
registerBuiltInStyle(STYLE_IDS.blockQuote, {
  name: 'Block Quote', kind: 'paragraph', basedOn: STYLE_IDS.body, fontSize: 10, firstLineIndent: 0, indentLeft: 2,
  indentRight: 2, spaceBefore: 6, spaceAfter: 6,
})
registerBuiltInStyle(STYLE_IDS.epigraph, {
  name: 'Epigraph', kind: 'paragraph', basedOn: STYLE_IDS.body, fontSize: 10, italic: true, firstLineIndent: 0,
  indentLeft: 4, spaceAfter: 12,
})
registerBuiltInStyle(STYLE_IDS.dedication, {
  name: 'Dedication', kind: 'paragraph', basedOn: STYLE_IDS.body, italic: true, align: 'center', firstLineIndent: 0,
  spaceBefore: 144, breakBefore: 'recto', nextStyle: STYLE_IDS.body,
})

/** The registered built-in definitions (a copy), in registration order. */
export function builtInStyles(): ReadonlyMap<string, StyleDef> {
  return new Map([...BUILT_INS].map(([id, d]) => [id, { ...d, builtIn: true }]))
}

export function isBuiltInStyle(id: string): boolean {
  return BUILT_INS.has(id)
}

// ---- narrowing --------------------------------------------------------------------------------

const ALIGNS: readonly string[] = ['left', 'center', 'right', 'justify']
const TRANSFORMS: readonly string[] = ['none', 'uppercase', 'lowercase', 'capitalize', 'small-caps']
const BREAKS: readonly string[] = ['none', 'page', 'recto']

const num = (v: unknown, min: number, max: number): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : undefined
const oneOf = <T extends string>(v: unknown, values: readonly string[]): T | undefined =>
  typeof v === 'string' && values.includes(v) ? (v as T) : undefined
const text = (v: unknown, max = 200): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, max) : undefined

/** Valid style id: lowercase letters, digits and dashes (safe in a CSS attribute selector). */
export const STYLE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

/**
 * Narrows one stored record to typed fields. Missing/invalid fields are absent; `null` stays null
 * (an explicit "unset" for a built-in override). Numbers are clamped to sane ranges.
 */
export function narrowStyleFields(raw: Record<string, unknown>): { [K in keyof StyleDef]?: StyleDef[K] | null } {
  const out: { [K in keyof StyleDef]?: StyleDef[K] | null } = {}
  const set = <K extends keyof StyleDef>(k: K, v: StyleDef[K] | undefined) => {
    if (raw[k] === null) out[k] = null
    else if (v !== undefined) out[k] = v
  }
  set('name', text(raw.name, 80))
  set('basedOn', typeof raw.basedOn === 'string' && STYLE_ID_PATTERN.test(raw.basedOn) ? raw.basedOn : undefined)
  set('kind', oneOf<StyleKind>(raw.kind, ['paragraph', 'chapter']))
  set('outlineLevel', raw.outlineLevel === 1 || raw.outlineLevel === 2 || raw.outlineLevel === 3 ? raw.outlineLevel : undefined)
  set('nextStyle', typeof raw.nextStyle === 'string' && STYLE_ID_PATTERN.test(raw.nextStyle) ? raw.nextStyle : undefined)
  set('fontFamily', text(raw.fontFamily, 120))
  set('fontSize', num(raw.fontSize, 4, 144))
  set('fontWeight', num(raw.fontWeight, 100, 900))
  set('italic', typeof raw.italic === 'boolean' ? raw.italic : undefined)
  set('align', oneOf<StyleAlign>(raw.align, ALIGNS))
  set('lineHeight', num(raw.lineHeight, 0.5, 5))
  set('spaceBefore', num(raw.spaceBefore, 0, 720))
  set('spaceAfter', num(raw.spaceAfter, 0, 720))
  set('firstLineIndent', num(raw.firstLineIndent, -10, 20))
  set('indentLeft', num(raw.indentLeft, 0, 30))
  set('indentRight', num(raw.indentRight, 0, 30))
  set('textTransform', oneOf<StyleTextTransform>(raw.textTransform, TRANSFORMS))
  set('letterSpacing', num(raw.letterSpacing, -0.5, 2))
  set('breakBefore', oneOf<BreakBefore>(raw.breakBefore, BREAKS))
  return out
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

/**
 * Own (unresolved) definitions: built-ins merged with their overrides, plus valid custom styles,
 * built-ins first (registration order), then custom styles in stored order.
 */
export function styleDefinitions(stored: StyleSheetJSON): Map<string, StyleDef> {
  const defs = new Map<string, StyleDef>()
  for (const [id, base] of BUILT_INS) {
    const raw = asRecord(stored[id])
    const merged: StyleDef = { ...base, builtIn: true }
    if (raw) {
      const o = narrowStyleFields(raw)
      for (const k of [...FORMAT_KEYS, 'name', 'nextStyle'] as const) {
        if (!(k in o)) continue
        const v = o[k]
        if (v === null) {
          if (k !== 'name') delete merged[k]
        } else (merged as unknown as Record<string, unknown>)[k] = v
      }
    }
    defs.set(id, merged)
  }
  for (const [id, value] of Object.entries(stored)) {
    if (BUILT_INS.has(id) || !STYLE_ID_PATTERN.test(id)) continue
    const raw = asRecord(value)
    if (!raw) continue
    const o = narrowStyleFields(raw)
    const def: StyleDef = { name: o.name ?? id, kind: o.kind ?? 'paragraph', builtIn: false }
    for (const k of DEF_KEYS) {
      if (k === 'name' || k === 'kind') continue
      const v = o[k]
      if (v !== undefined && v !== null) (def as unknown as Record<string, unknown>)[k] = v
    }
    defs.set(id, def)
  }
  return defs
}

/**
 * Resolves every style through its `basedOn` chain (cycles and dangling parents are cut). The
 * result is O(number of styles x chain depth) and never touches the document.
 */
export function resolveStyleSheet(stored: StyleSheetJSON): ResolvedStyles {
  const defs = styleDefinitions(stored)
  const out = new Map<string, ResolvedStyle>()
  const resolving = new Set<string>()
  const resolve = (id: string): ResolvedStyle => {
    const done = out.get(id)
    if (done) return done
    const def = defs.get(id)!
    resolving.add(id)
    const usable = (p: string | undefined) => !!p && p !== id && defs.has(p) && !resolving.has(p)
    // A dangling or cyclic parent falls back to Body, so a broken chain still renders as text.
    const parentId = usable(def.basedOn) ? def.basedOn : def.basedOn && usable(DEFAULT_STYLE_ID) ? DEFAULT_STYLE_ID : undefined
    const parent = parentId ? resolve(parentId) : undefined
    resolving.delete(id)
    const r: ResolvedStyle = { ...def, id, basedOn: parentId }
    if (parent) for (const k of FORMAT_KEYS) if (r[k] === undefined && parent[k] !== undefined) (r as unknown as Record<string, unknown>)[k] = parent[k]
    if (r.nextStyle && !defs.has(r.nextStyle)) delete r.nextStyle
    out.set(id, r)
    return r
  }
  for (const id of defs.keys()) resolve(id)
  return out
}

// ---- writing ----------------------------------------------------------------------------------

/**
 * Writes `def` for `id` into the stored sheet (returns a new object; unknown keys of the record are
 * kept). Built-ins store only the differences from the registered default (null where the default
 * sets a value the user cleared); custom styles store the full definition.
 */
export function writeStyle(stored: StyleSheetJSON, id: string, def: Omit<StyleDef, 'builtIn'>): StyleSheetJSON {
  const prev = asRecord(stored[id]) ?? {}
  const rec: Record<string, unknown> = { ...prev }
  const base = BUILT_INS.get(id)
  if (base) {
    for (const k of [...FORMAT_KEYS, 'name', 'nextStyle'] as const) {
      const v = def[k]
      const b = base[k]
      if (v === b || (v === undefined && b === undefined)) delete rec[k]
      else rec[k] = v === undefined ? null : v
    }
    for (const k of ['basedOn', 'kind', 'outlineLevel', 'builtIn'] as const) delete rec[k]
    const next = { ...stored }
    if (Object.keys(rec).length === 0) delete next[id]
    else next[id] = rec
    return next
  }
  for (const k of DEF_KEYS) {
    const v = def[k]
    if (v === undefined) delete rec[k]
    else rec[k] = v
  }
  rec.builtIn = false
  return { ...stored, [id]: rec }
}

/** Removes a custom style and re-points styles that referred to it. Built-ins cannot be removed. */
export function removeStyle(stored: StyleSheetJSON, id: string, replacement: string): StyleSheetJSON {
  if (BUILT_INS.has(id)) return stored
  const next: StyleSheetJSON = {}
  for (const [k, v] of Object.entries(stored)) {
    if (k === id) continue
    const rec = asRecord(v)
    if (!rec || (rec.basedOn !== id && rec.nextStyle !== id)) {
      next[k] = v as Record<string, unknown>
      continue
    }
    const copy = { ...rec }
    if (copy.basedOn === id) copy.basedOn = replacement
    if (copy.nextStyle === id) delete copy.nextStyle
    next[k] = copy
  }
  return next
}

/** A new custom style id not used in `taken`. */
export function newStyleId(taken: Iterable<string>): string {
  const used = new Set(taken)
  for (let n = 1; ; n++) if (!used.has(`custom-${n}`)) return `custom-${n}`
}

// ---- rendering --------------------------------------------------------------------------------

const fmt = (n: number) => String(+n.toFixed(4))
const pt = (n: number) => (n === 0 ? '0' : `calc(${fmt(n)} * var(${BOOK_POINT_VAR}, 1pt))`)

/** Quotes a font family name for CSS (only letters, digits, spaces and a few safe marks survive). */
function cssFontFamily(name: string): string {
  const clean = name.replace(/[^\p{L}\p{N} _.&+-]/gu, '').trim()
  return clean ? `"${clean}", serif` : 'inherit'
}

/** CSS declarations for one resolved style (no selector). Shared by the sheet and dialog previews. */
export function styleDeclarations(s: StyleFormat): Array<[property: string, value: string]> {
  const d: Array<[string, string]> = []
  if (s.fontFamily) d.push(['font-family', cssFontFamily(s.fontFamily)])
  if (s.fontSize !== undefined) d.push(['font-size', pt(s.fontSize)])
  if (s.fontWeight !== undefined) d.push(['font-weight', String(Math.round(s.fontWeight))])
  if (s.italic !== undefined) d.push(['font-style', s.italic ? 'italic' : 'normal'])
  if (s.align) d.push(['text-align', s.align])
  if (s.lineHeight !== undefined) d.push(['line-height', fmt(s.lineHeight)])
  if (s.spaceBefore !== undefined) d.push(['margin-top', pt(s.spaceBefore)])
  if (s.spaceAfter !== undefined) d.push(['margin-bottom', pt(s.spaceAfter)])
  if (s.firstLineIndent !== undefined) d.push(['text-indent', `${fmt(s.firstLineIndent)}em`])
  if (s.indentLeft !== undefined) d.push(['margin-left', `${fmt(s.indentLeft)}em`])
  if (s.indentRight !== undefined) d.push(['margin-right', `${fmt(s.indentRight)}em`])
  if (s.textTransform === 'small-caps') d.push(['text-transform', 'none'], ['font-variant-caps', 'all-small-caps'])
  else if (s.textTransform) d.push(['text-transform', s.textTransform], ['font-variant-caps', 'normal'])
  if (s.letterSpacing !== undefined) d.push(['letter-spacing', `${fmt(s.letterSpacing)}em`])
  return d
}

const declarationText = (s: StyleFormat) => styleDeclarations(s).map(([p, v]) => `${p}: ${v};`).join(' ')

/**
 * True when a block of style `id` directly after a block of style `prevId` continues a heading
 * group: the previous style breaks, names this one as its next style, and this one breaks too
 * (e.g. Chapter Number followed by Chapter Title). The group breaks once, before its first block,
 * and its later blocks get no space before.
 */
export function continuesHeadingGroup(prevId: string | null, id: string, styles: ResolvedStyles): boolean {
  if (!prevId || prevId === id) return false
  const prev = styles.get(prevId)
  const cur = styles.get(id)
  return !!prev && !!cur && prev.nextStyle === id && isBreaking(prev) && isBreaking(cur)
}

const isBreaking = (s: StyleFormat) => s.breakBefore === 'page' || s.breakBefore === 'recto'

/**
 * The generated stylesheet: one rule per style keyed by `[data-style="<id>"]` under `scope`, so
 * editing a definition costs O(number of styles) and never touches the document. Inline styles
 * from direct formatting (align, spacing, indent attributes; text marks) win over these rules.
 */
export function buildStyleSheetCSS(styles: ResolvedStyles, scope: string): string {
  const rules: string[] = []
  // Fallbacks first, for a data-style naming no defined style (deleted then brought back by undo or
  // redo, pasted, or an out-of-sync book.json): paragraphs look like Body, headings like their
  // migration default. Same specificity as the per-id rules below, which come later and win.
  const fallbacks: Array<[string, string]> = [
    [':where(p)', DEFAULT_STYLE_ID],
    [':where(h1)', STYLE_IDS.chapterTitle],
    [':where(h2, h3)', STYLE_IDS.subheading],
  ]
  for (const [selector, id] of fallbacks) {
    const s = styles.get(id)
    if (s) rules.push(`${scope} ${selector}[data-style] { ${declarationText(s)} }`)
  }
  for (const s of styles.values()) {
    if (!STYLE_ID_PATTERN.test(s.id)) continue
    rules.push(`${scope} [data-style="${s.id}"] { ${declarationText(s)} }`)
  }
  for (const prev of styles.values()) {
    if (prev.nextStyle && continuesHeadingGroup(prev.id, prev.nextStyle, styles)) {
      rules.push(`${scope} [data-style="${prev.id}"] + [data-style="${prev.nextStyle}"] { margin-top: 0; }`)
    }
  }
  // Paragraphs inside list items keep the list's own geometry.
  rules.push(`${scope} li > [data-style] { text-indent: 0; margin-top: 0; margin-bottom: 0; }`)
  return rules.join('\n')
}

/** Inline-style object (React) for previews of a style outside the manuscript. */
export function styleToInlineCSS(s: StyleFormat): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [p, v] of styleDeclarations(s)) out[p.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())] = v
  return out
}
