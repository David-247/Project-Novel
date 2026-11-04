import { describe, expect, it } from 'vitest'
import { DEFAULT_MARGINS, defaultBookSettings, defaultHeaderFooter } from '@/shared/book'
import { bookWarningText, normalizeBook, parseBook, serializeBook } from './book-file'

describe('book.json format', () => {
  it('round-trips settings, including opaque sections and unknown keys', () => {
    const settings = {
      ...defaultBookSettings(),
      trimSize: 'uk-royal',
      margins: { top: 50, bottom: 51, inside: 52, outside: 53 },
      styles: { body: { fontSize: 11, future: { a: [1, 2] } } },
      headerFooter: {
        ...defaultHeaderFooter(),
        verso: { kind: 'custom' as const, text: 'Chapter ink' },
        frontMatter: 'roman' as const,
        extra: { sectionsLater: [1] },
      },
      footnotes: { restart: 'chapter' },
      surface: 'dark' as const,
      view: 'single' as const,
      extra: { fromTheFuture: { ok: true } },
    }
    const parsed = parseBook(serializeBook(settings))
    expect(parsed.warnings).toEqual([])
    expect(parsed.settings).toEqual(settings)
    expect(JSON.parse(serializeBook(settings))).toMatchObject({ format: 'novel-book', version: 1, fromTheFuture: { ok: true } })
  })

  it('an empty object gives defaults without warnings', () => {
    expect(parseBook('{}')).toEqual({ settings: defaultBookSettings(), warnings: [] })
  })

  it('invalid values fall back to defaults field by field and are reported', () => {
    const { settings, warnings } = parseBook(
      JSON.stringify({
        trimSize: 'huge',
        margins: { top: -4, bottom: 'x', inside: 70, outside: 1e9 },
        styles: [1],
        headerFooter: 'no',
        footnotes: null,
        surface: 'neon',
        view: 3,
        keep: 1,
      }),
    )
    expect(settings).toEqual({
      ...defaultBookSettings(),
      margins: { ...DEFAULT_MARGINS, inside: 70 },
      extra: { keep: 1 },
    })
    expect(warnings).toEqual([
      'the trim size',
      'the margins',
      'the styles',
      'the headers and footers',
      'the footnote settings',
      'the paper surface',
      'the page view',
    ])
    expect(bookWarningText(warnings)).toMatch(/invalid values.*default book settings/)
  })

  it.each(['', '{not json', '[1,2]', '"x"', 'null'])('damaged file %j gives defaults and a whole-file warning', (text) => {
    const r = parseBook(text)
    expect(r.settings).toEqual(defaultBookSettings())
    expect(r.warnings).toEqual(['the whole file'])
    expect(bookWarningText(r.warnings)).toMatch(/book\.json is damaged/)
  })

  it('a newer format version is reported (settings still read as far as this version knows them)', () => {
    const r = parseBook(JSON.stringify({ format: 'novel-book', version: 2, trimSize: 'uk-a5', styles: { body: { fontSize: 12 } }, laterThing: 1 }))
    expect(r.newerVersion).toBe(2)
    expect(r.warnings).toEqual([])
    expect(r.settings).toMatchObject({ trimSize: 'uk-a5', styles: { body: { fontSize: 12 } }, extra: { laterThing: 1 } })
    expect(bookWarningText([], true, 2)).toMatch(/book\.json was saved by a newer version of Novel \(format version 2\).*left as it is/)
    // Values replaced by defaults are listed in the newer-version warning too.
    const mixed = parseBook(JSON.stringify({ version: 3, trimSize: 'giant', surface: 'neon' }))
    expect(mixed.warnings).toEqual(['the trim size', 'the paper surface'])
    expect(bookWarningText(mixed.warnings, true, mixed.newerVersion)).toMatch(
      /format version 3\).*replaced by defaults \(the trim size, the paper surface\)/,
    )
    // The current version, a missing one or a malformed one is not "newer".
    for (const version of [1, undefined, '9', 2.5]) expect(parseBook(JSON.stringify({ version })).newerVersion).toBeUndefined()
  })

  it('normalizeBook does not share references with its input defaults', () => {
    const a = normalizeBook({}).settings
    a.margins.top = 1
    expect(normalizeBook({}).settings.margins.top).toBe(DEFAULT_MARGINS.top)
  })
})
