import { describe, expect, it } from 'vitest'
import {
  defaultHeaderFooter,
  headerFooterToJSON,
  makeHeaderFooterResolver,
  parseHeaderFooter,
  resolveHeaderFooter,
  toLowerRoman,
  type HeaderFooterSettings,
  type HFChapter,
  type HFPage,
} from './header-footer'

const META = { title: 'The Long Road', author: 'A. Writer' }

/**
 * Layout used below (page 0 is a recto):
 *   0 recto  front matter (title page)
 *   1 verso  front matter
 *   2 recto  chapter 0 opens ("One")
 *   3 verso  body
 *   4 recto  body
 *   5 verso  BLANK (left by a recto break)
 *   6 recto  chapter 1 opens ("Two")
 *   7 verso  body, chapter 1
 */
function layout(): { pages: HFPage[]; chapters: HFChapter[] } {
  const mk = (index: number, from: number, to: number, chapterIndex: number, isBlank = false): HFPage => ({
    index,
    side: index % 2 === 0 ? 'recto' : 'verso',
    from,
    to,
    isBlank,
    chapterIndex,
  })
  const pages = [
    mk(0, 0, 100, -1),
    mk(1, 100, 200, -1),
    mk(2, 200, 300, 0),
    mk(3, 300, 400, 0),
    mk(4, 400, 500, 0),
    mk(5, 500, 500, 0, true),
    mk(6, 500, 600, 1),
    mk(7, 600, 700, 1),
  ]
  const chapters: HFChapter[] = [
    { index: 0, title: 'One', from: 200 },
    { index: 1, title: 'Two', from: 500 },
  ]
  return { pages, chapters }
}

const settings = (patch: Partial<HeaderFooterSettings> = {}): HeaderFooterSettings => ({ ...defaultHeaderFooter(), ...patch })
const at = (i: number, s = settings(), l = layout(), meta = META) => resolveHeaderFooter(l.pages[i], l.pages, l.chapters, s, meta)

describe('resolveHeaderFooter: header content per side', () => {
  it('defaults to the author on verso pages and the book title on recto pages', () => {
    expect(at(3).headerText).toBe('A. Writer')
    expect(at(4).headerText).toBe('The Long Road')
    expect(at(7).headerText).toBe('A. Writer')
  })

  it('supports none, chapter title and custom text per side', () => {
    const s = settings({ verso: { kind: 'chapter', text: '' }, recto: { kind: 'custom', text: '  A Novel  ' } })
    expect(at(3, s).headerText).toBe('One')
    expect(at(7, s).headerText).toBe('Two')
    expect(at(4, s).headerText).toBe('A Novel')
    expect(at(4, settings({ recto: { kind: 'none', text: 'ignored' } })).headerText).toBe('')
  })

  it('shows nothing for an empty title, author or chapter title', () => {
    expect(at(4, settings(), layout(), { title: '', author: '' }).headerText).toBe('')
    const l = layout()
    l.chapters[0].title = '   '
    expect(at(3, settings({ verso: { kind: 'chapter', text: '' } }), l).headerText).toBe('')
  })

  it('has no running head in front matter', () => {
    expect(at(0).headerText).toBe('')
    expect(at(1).headerText).toBe('')
  })
})

describe('resolveHeaderFooter: suppression', () => {
  it('suppresses the header and the number on chapter-opening pages by default', () => {
    expect(at(2)).toMatchObject({ headerText: '', number: '', numberPosition: null })
    expect(at(6)).toMatchObject({ headerText: '', number: '', numberPosition: null })
  })

  it('can keep the header or the number on chapter-opening pages independently', () => {
    expect(at(2, settings({ suppressHeaderOnOpening: false })).headerText).toBe('The Long Road')
    expect(at(2, settings({ suppressNumberOnOpening: false })).number).toBe('1')
    expect(at(2, settings({ suppressNumberOnOpening: false })).headerText).toBe('')
  })

  it('suppresses blank pages, which still count in the numbering', () => {
    expect(at(5)).toMatchObject({ headerText: '', number: '', numberPosition: null })
    expect(at(7).number).toBe('6') // 2 -> 1, 3 -> 2, 4 -> 3, 5 (blank) -> 4, 6 -> 5, 7 -> 6
    const shown = at(5, settings({ suppressOnBlank: false }))
    expect(shown.number).toBe('4')
    expect(shown.headerText).toBe('A. Writer')
  })

  it('treats a chapter that starts in the middle of a page as an opening page', () => {
    const l = layout()
    l.chapters[1].from = 650 // inside page 7
    expect(at(7, settings(), l).headerText).toBe('')
    expect(at(6, settings(), l).headerText).toBe('The Long Road')
  })
})

describe('resolveHeaderFooter: page numbers', () => {
  it('restarts at 1 on the first chapter; front matter is unnumbered by default', () => {
    expect([0, 1].map((i) => at(i).number)).toEqual(['', ''])
    expect(at(3).number).toBe('2')
    expect(at(4).number).toBe('3')
    expect(at(2, settings({ suppressNumberOnOpening: false })).number).toBe('1')
  })

  it('numbers front matter in lower-case Roman numerals when asked', () => {
    const s = settings({ frontMatter: 'roman' })
    expect(at(0, s).number).toBe('i')
    expect(at(1, s).number).toBe('ii')
    expect(at(3, s).number).toBe('2')
  })

  it('uses the starting number', () => {
    const s = settings({ pageNumber: { position: 'footer-centre', format: 'arabic', start: 7 } })
    expect(at(3, s).number).toBe('8')
    expect(at(4, s).number).toBe('9')
  })

  it('without restarting, page 1 gets the starting number and front matter is counted', () => {
    const s = settings({ restartAtFirstChapter: false, frontMatter: 'roman' })
    expect(at(1, s).number).toBe('ii')
    expect(at(3, s).number).toBe('4')
    expect(at(3, settings({ restartAtFirstChapter: false, pageNumber: { position: 'footer-centre', format: 'arabic', start: 0 } })).number).toBe('3')
  })

  it('formats the body in lower-case Roman numerals', () => {
    const s = settings({ pageNumber: { position: 'footer-centre', format: 'lower-roman', start: 1 } })
    expect(at(4, s).number).toBe('iii')
  })

  it('reports the position, or none', () => {
    expect(at(3, settings({ pageNumber: { position: 'footer-outside', format: 'arabic', start: 1 } }))).toMatchObject({
      number: '2',
      numberPosition: 'footer-outside',
      side: 'verso',
    })
    expect(at(4, settings({ pageNumber: { position: 'header-outside', format: 'arabic', start: 1 } })).numberPosition).toBe('header-outside')
    expect(at(3, settings({ pageNumber: { position: 'none', format: 'arabic', start: 1 } }))).toMatchObject({ number: '', numberPosition: null })
  })

  it('a book without chapters is all body, numbered from page 1', () => {
    const l = layout()
    expect(resolveHeaderFooter(l.pages[0], l.pages, [], settings(), META)).toMatchObject({ number: '1', headerText: 'The Long Road' })
    expect(resolveHeaderFooter(l.pages[3], l.pages, [], settings(), META).number).toBe('4')
  })

  it('a bound resolver agrees with resolveHeaderFooter on every page', () => {
    const l = layout()
    const s = settings({ frontMatter: 'roman' })
    const bound = makeHeaderFooterResolver(l.pages, l.chapters, s, META)
    for (const p of l.pages) expect(bound(p)).toEqual(resolveHeaderFooter(p, l.pages, l.chapters, s, META))
  })
})

describe('toLowerRoman', () => {
  it('converts', () => {
    expect([1, 4, 9, 14, 40, 90, 399, 1994].map(toLowerRoman)).toEqual(['i', 'iv', 'ix', 'xiv', 'xl', 'xc', 'cccxcix', 'mcmxciv'])
  })
  it('falls back to digits outside 1-3999', () => {
    expect([0, -2, 4000].map(toLowerRoman)).toEqual(['0', '-2', '4000'])
  })
})

describe('parseHeaderFooter / headerFooterToJSON', () => {
  it('a missing value is the defaults, with nothing repaired', () => {
    expect(parseHeaderFooter(undefined)).toEqual({ settings: defaultHeaderFooter(), repaired: false })
    expect(parseHeaderFooter({})).toEqual({ settings: defaultHeaderFooter(), repaired: false })
  })

  it('replaces invalid values with their defaults and keeps the valid ones', () => {
    const r = parseHeaderFooter({
      verso: { kind: 'nonsense', text: 5 },
      recto: { kind: 'custom', text: 'Hello' },
      pageNumber: { position: 'footer-outside', format: 'hex', start: 1.5 },
      frontMatter: 'roman',
      suppressOnBlank: 'yes',
    })
    expect(r.repaired).toBe(true)
    expect(r.settings.verso).toEqual({ kind: 'author', text: '' })
    expect(r.settings.recto).toEqual({ kind: 'custom', text: 'Hello' })
    expect(r.settings.pageNumber).toEqual({ position: 'footer-outside', format: 'arabic', start: 1 })
    expect(r.settings.frontMatter).toBe('roman')
    expect(r.settings.suppressOnBlank).toBe(true)
    expect(parseHeaderFooter('x').repaired).toBe(true)
  })

  it('keeps unknown keys through a round trip', () => {
    const r = parseHeaderFooter({ futureThing: { a: 1 }, frontMatter: 'roman' })
    expect(r.repaired).toBe(false)
    expect(r.settings.extra).toEqual({ futureThing: { a: 1 } })
    const json = headerFooterToJSON(r.settings)
    expect(json.futureThing).toEqual({ a: 1 })
    expect(parseHeaderFooter(json).settings).toEqual(r.settings)
  })

  it('round-trips the defaults', () => {
    expect(parseHeaderFooter(headerFooterToJSON(defaultHeaderFooter()))).toEqual({ settings: defaultHeaderFooter(), repaired: false })
  })
})
