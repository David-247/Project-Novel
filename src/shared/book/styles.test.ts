import { describe, expect, it } from 'vitest'
import {
  buildStyleSheetCSS,
  builtInStyles,
  continuesHeadingGroup,
  newStyleId,
  registerBuiltInStyle,
  removeStyle,
  resolveStyleSheet,
  STYLE_IDS,
  styleDefinitions,
  writeStyle,
} from './styles'

const SCOPE = '.ed'

describe('built-in styles', () => {
  it('apply when book.styles is {} (no migration write needed)', () => {
    const r = resolveStyleSheet({})
    expect([...r.keys()]).toEqual([
      'body', 'first-paragraph', 'chapter-number', 'chapter-title', 'part-title', 'subheading',
      'scene-break', 'block-quote', 'epigraph', 'dedication',
    ])
    expect(r.get('body')).toMatchObject({ name: 'Body', kind: 'paragraph', fontSize: 11, firstLineIndent: 1.5, builtIn: true })
    expect(r.get('chapter-title')).toMatchObject({ kind: 'chapter', breakBefore: 'page', nextStyle: 'first-paragraph' })
    expect(r.get('part-title')!.breakBefore).toBe('recto')
    expect(r.get('first-paragraph')).toMatchObject({ firstLineIndent: 0, nextStyle: 'body' })
  })

  it('inherit unset properties through basedOn', () => {
    const r = resolveStyleSheet({ body: { fontSize: 12 } })
    expect(r.get('first-paragraph')!.fontSize).toBe(12)
    expect(r.get('first-paragraph')!.lineHeight).toBe(1.5)
    // Own values win over the parent's.
    expect(r.get('chapter-title')!.fontSize).toBe(20)
  })

  it('registering a built-in is one call, and it appears in the resolved sheet', () => {
    registerBuiltInStyle('test-running-head', { name: 'Running Head', kind: 'paragraph', basedOn: 'body', fontSize: 9 })
    const r = resolveStyleSheet({})
    expect(r.get('test-running-head')).toMatchObject({ builtIn: true, fontSize: 9, lineHeight: 1.5 })
    expect(builtInStyles().has('test-running-head')).toBe(true)
  })
})

describe('stored overrides', () => {
  it('merge over built-ins, keep unknown keys, and null unsets a built-in value', () => {
    const stored = { 'chapter-title': { fontSize: 28, breakBefore: 'recto', fontFamily: null, futureKey: 7 } }
    const r = resolveStyleSheet(stored)
    expect(r.get('chapter-title')).toMatchObject({ fontSize: 28, breakBefore: 'recto' })
    const written = writeStyle(stored, 'chapter-title', { ...styleDefinitions(stored).get('chapter-title')!, fontSize: 30 })
    expect(written['chapter-title']).toEqual({ fontSize: 30, breakBefore: 'recto', futureKey: 7 })
  })

  it('writing a built-in back to its defaults removes the override', () => {
    const def = styleDefinitions({}).get('body')!
    expect(writeStyle({ body: { fontSize: 12 } }, 'body', def)).toEqual({})
    // Clearing a value the built-in sets stores null (explicit inherit).
    const cleared = writeStyle({}, 'chapter-title', { ...styleDefinitions({}).get('chapter-title')!, fontSize: undefined })
    expect(cleared['chapter-title']).toEqual({ fontSize: null })
    expect(resolveStyleSheet(cleared).get('chapter-title')!.fontSize).toBe(11)
  })

  it('ignores invalid values and ids, clamps numbers, cuts basedOn cycles', () => {
    const r = resolveStyleSheet({
      body: { fontSize: 'huge', lineHeight: 99 },
      'Bad Id': { name: 'x', kind: 'paragraph' },
      a: { name: 'A', kind: 'paragraph', basedOn: 'b', fontSize: 9 },
      b: { name: 'B', kind: 'paragraph', basedOn: 'a' },
    })
    expect(r.get('body')!.fontSize).toBe(11)
    expect(r.get('body')!.lineHeight).toBe(5)
    expect(r.has('Bad Id')).toBe(false)
    expect(r.get('a')!.fontSize).toBe(9)
    // The cycle is cut where it closes; that style falls back to Body.
    expect(r.get('b')!.fontSize).toBe(11)
  })

  it('custom styles: full definition stored, removal re-points dependants', () => {
    let s = writeStyle({}, 'custom-1', { name: 'Letter', kind: 'paragraph', basedOn: 'body', italic: true })
    s = writeStyle(s, 'custom-2', { name: 'Letter sign-off', kind: 'paragraph', basedOn: 'custom-1', nextStyle: 'custom-1' })
    expect(s['custom-1']).toEqual({ name: 'Letter', kind: 'paragraph', basedOn: 'body', italic: true, builtIn: false })
    expect(resolveStyleSheet(s).get('custom-2')!.italic).toBe(true)
    const removed = removeStyle(s, 'custom-1', 'body')
    expect(removed['custom-1']).toBeUndefined()
    expect(removed['custom-2']).toEqual({ name: 'Letter sign-off', kind: 'paragraph', basedOn: 'body', builtIn: false })
    expect(removeStyle(s, 'body', 'body')).toBe(s)
    expect(newStyleId(Object.keys(s))).toBe('custom-3')
  })
})

describe('generated stylesheet', () => {
  it('has one rule per style keyed by data-style, in book points', () => {
    const css = buildStyleSheetCSS(resolveStyleSheet({}), SCOPE)
    expect(css).toContain('.ed [data-style="body"] { font-size: calc(11 * var(--nv-pt, 1pt));')
    expect(css).toContain('text-indent: 1.5em;')
    expect(css).toMatch(/\[data-style="chapter-number"\] \{[^}]*font-variant-caps: all-small-caps;/)
    // Heading group: a chapter title right after a chapter number shares its space and its break.
    expect(css).toContain('.ed [data-style="chapter-number"] + [data-style="chapter-title"] { margin-top: 0; }')
    expect(css.split('\n').filter((l) => l.startsWith('.ed [data-style="')).length).toBeGreaterThanOrEqual(10)
  })

  it('changing a definition changes only that rule; cost is independent of the document', () => {
    const before = buildStyleSheetCSS(resolveStyleSheet({}), SCOPE).split('\n')
    const after = buildStyleSheetCSS(resolveStyleSheet({ 'chapter-title': { fontSize: 30 } }), SCOPE).split('\n')
    const changed = after.filter((l, i) => l !== before[i])
    expect(changed).toHaveLength(1)
    expect(changed[0]).toContain('[data-style="chapter-title"]')
    expect(changed[0]).toContain('calc(30 * var(--nv-pt, 1pt))')
  })

  it('sanitizes font names (no CSS injection from book.json)', () => {
    const css = buildStyleSheetCSS(resolveStyleSheet({ body: { fontFamily: 'Evil"; } body { color: red' } }), SCOPE)
    expect(css).toContain('font-family: "Evil  body  color red", serif;')
  })

  it('heading groups follow nextStyle + breakBefore', () => {
    const r = resolveStyleSheet({})
    expect(continuesHeadingGroup(STYLE_IDS.chapterNumber, STYLE_IDS.chapterTitle, r)).toBe(true)
    expect(continuesHeadingGroup(STYLE_IDS.partTitle, STYLE_IDS.chapterTitle, r)).toBe(false)
    expect(continuesHeadingGroup(STYLE_IDS.chapterTitle, STYLE_IDS.firstParagraph, r)).toBe(false)
  })
})
