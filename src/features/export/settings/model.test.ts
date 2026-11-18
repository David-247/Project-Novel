import { describe, expect, it } from 'vitest'
import {
  applyPreset,
  checkWordCount,
  CLASSIC_PRESET,
  defaultManuscriptSettings,
  formatWordCount,
  GENRE_WORD_COUNTS,
  paperFromLocale,
  PRESETS,
  resolveContact,
  roundWordCount,
  runningHeader,
  STANDARD_PRESET,
  surnameOf,
} from './index'

describe('defaults', () => {
  it('are the Standard (modern) preset on the paper of the locale', () => {
    const s = defaultManuscriptSettings('en-US')
    expect(s).toMatchObject({
      preset: 'standard',
      paper: 'letter',
      fontFamily: 'Times New Roman',
      fontSizePt: 12,
      lineSpacing: 2,
      margins: { top: 1, right: 1, bottom: 1, left: 1 },
      firstLineIndentIn: 0.5,
      indentFirstParagraph: true,
      italics: 'italic',
      sentenceSpacing: 1,
      sceneBreak: '#',
      endMarker: 'none',
      chapterDropFraction: 1 / 3,
      outputs: { docx: true, pdf: true },
      lastOutputFolder: null,
    })
    expect(s.header).toMatchObject({ format: 'surname-title-page', startPage: 2, titleCase: 'as-typed' })
    expect(s.wordCountRounding).toBe('auto')
  })
  it('take A4 from a UK locale', () => {
    expect(defaultManuscriptSettings('en-GB').paper).toBe('a4')
  })
  it('return fresh objects (no shared mutable state)', () => {
    const a = defaultManuscriptSettings('en-US')
    a.margins.left = 2
    expect(defaultManuscriptSettings('en-US').margins.left).toBe(1)
  })
})

describe('paperFromLocale', () => {
  it.each([
    ['en-US', 'letter'],
    ['en-CA', 'letter'],
    ['es-MX', 'letter'],
    ['en-GB', 'a4'],
    ['en-AU', 'a4'],
    ['en-NZ', 'a4'],
    ['de-DE', 'a4'],
    ['fr-FR', 'a4'],
    ['en', 'letter'],
    ['', 'letter'],
    ['zh-Hans-CN', 'a4'],
    ['en_US', 'letter'],
  ])('%s -> %s', (locale, paper) => expect(paperFromLocale(locale)).toBe(paper))
})

describe('presets', () => {
  it('Standard: Times New Roman, italics', () => {
    expect(STANDARD_PRESET).toMatchObject({ fontFamily: 'Times New Roman', italics: 'italic', sentenceSpacing: 1 })
  })
  it('Classic: Courier, underline for italics, two spaces after a sentence', () => {
    expect(CLASSIC_PRESET).toMatchObject({ fontFamily: 'Courier New', italics: 'underline', sentenceSpacing: 2, fontSizePt: 12 })
  })
  it('lists both', () => expect(Object.keys(PRESETS).sort()).toEqual(['classic', 'standard']))
  it('applyPreset changes the look but keeps the user choices', () => {
    const base = { ...defaultManuscriptSettings('en-GB'), sceneBreak: '* * *', lastOutputFolder: '/out' }
    const classic = applyPreset(base, 'classic')
    expect(classic).toMatchObject({ preset: 'classic', fontFamily: 'Courier New', italics: 'underline', paper: 'a4', sceneBreak: '* * *', lastOutputFolder: '/out' })
    expect(applyPreset(classic, 'standard')).toMatchObject({ preset: 'standard', fontFamily: 'Times New Roman', italics: 'italic' })
  })
})

describe('roundWordCount', () => {
  it('auto: nearest 100 under 20,000, nearest 500 from 20,000', () => {
    expect(roundWordCount(1507, 'auto')).toBe(1500)
    expect(roundWordCount(19_949, 'auto')).toBe(19_900)
    expect(roundWordCount(79_874, 'auto')).toBe(80_000)
    expect(roundWordCount(82_260, 'auto')).toBe(82_500)
  })
  it('fixed rules round half up', () => {
    expect(roundWordCount(1550, 'nearest-100')).toBe(1600)
    expect(roundWordCount(82_260, 'nearest-1000')).toBe(82_000)
    expect(roundWordCount(82_500, 'nearest-1000')).toBe(83_000)
    expect(roundWordCount(82_260, 'exact')).toBe(82_260)
  })
  it('never negative or fractional', () => {
    expect(roundWordCount(0, 'auto')).toBe(0)
    expect(roundWordCount(-5, 'nearest-100')).toBe(0)
    expect(roundWordCount(12.6, 'exact')).toBe(13)
  })
  it('formats the title-page line', () => {
    expect(formatWordCount(79_874, 'auto')).toBe('about 80,000 words')
    expect(formatWordCount(1_507, 'auto')).toBe('about 1,500 words')
    expect(formatWordCount(82_260, 'exact')).toBe('82,260 words')
    expect(formatWordCount(1, 'exact')).toBe('1 word')
  })
})

describe('surnameOf', () => {
  it.each([
    ['Perry Slaughter', 'Slaughter'],
    ['  Ada   Lovelace ', 'Lovelace'],
    ['Martin Luther King Jr.', 'King'],
    ['Madonna', 'Madonna'],
    ['', ''],
    ['J. R. R. Tolkien', 'Tolkien'],
  ])('%j -> %j', (name, surname) => expect(surnameOf(name)).toBe(surname))
})

describe('runningHeader', () => {
  const ctx = { surname: 'Slaughter', shortTitle: 'Silvertide', page: 13 }
  it('is Surname / Title / page by default', () => {
    expect(runningHeader({ format: 'surname-title-page', titleCase: 'as-typed' }, ctx)).toBe('Slaughter / Silvertide / 13')
  })
  it('can upper-case the title', () => {
    expect(runningHeader({ format: 'surname-title-page', titleCase: 'upper' }, ctx)).toBe('Slaughter / SILVERTIDE / 13')
  })
  it('has other formats', () => {
    expect(runningHeader({ format: 'title-surname-page', titleCase: 'as-typed' }, ctx)).toBe('Silvertide / Slaughter / 13')
    expect(runningHeader({ format: 'surname-page', titleCase: 'as-typed' }, ctx)).toBe('Slaughter / 13')
    expect(runningHeader({ format: 'page', titleCase: 'as-typed' }, ctx)).toBe('13')
    expect(runningHeader({ format: 'none', titleCase: 'as-typed' }, ctx)).toBe('')
  })
  it('drops an empty part instead of leaving a dangling slash', () => {
    expect(runningHeader({ format: 'surname-title-page', titleCase: 'as-typed' }, { ...ctx, surname: '' })).toBe('Silvertide / 13')
  })
})

describe('resolveContact', () => {
  const profile = { legalName: 'Ada Lovelace', penName: 'A. L. Byron', address: '1 St James Sq\nLondon', phone: '555', email: 'ada@example.com', agent: '' }
  it('is the app profile when there is no override', () => {
    expect(resolveContact(profile, {})).toEqual(profile)
  })
  it('a non-empty override field wins; an empty one falls back to the profile', () => {
    expect(resolveContact(profile, { email: 'book@example.com', phone: '' })).toMatchObject({ email: 'book@example.com', phone: '555', legalName: 'Ada Lovelace' })
  })
  it('byline name is the pen name when set, else the legal name', () => {
    expect(resolveContact(profile, {}).penName).toBe('A. L. Byron')
    expect(resolveContact({ ...profile, penName: '' }, {}).penName).toBe('')
  })
})

describe('genre word-count table', () => {
  it('covers the genres the wizard checks, each with a source', () => {
    for (const id of ['literary', 'commercial', 'fantasy', 'science-fiction', 'romance', 'mystery', 'thriller', 'ya', 'middle-grade']) {
      const g = GENRE_WORD_COUNTS.find((x) => x.id === id)
      expect(g, id).toBeDefined()
      expect(g!.sources.length).toBeGreaterThan(0)
      expect(g!.typical.min).toBeLessThan(g!.typical.max)
    }
  })
  it('has unique ids and sane debut ranges', () => {
    expect(new Set(GENRE_WORD_COUNTS.map((g) => g.id)).size).toBe(GENRE_WORD_COUNTS.length)
    for (const g of GENRE_WORD_COUNTS) if (g.debut) expect(g.debut.min).toBeLessThan(g.debut.max)
  })
  it('checkWordCount classifies a manuscript', () => {
    expect(checkWordCount('thriller', 90_000)).toMatchObject({ status: 'within' })
    expect(checkWordCount('thriller', 60_000)).toMatchObject({ status: 'short' })
    expect(checkWordCount('thriller', 110_000)).toMatchObject({ status: 'long' })
    expect(checkWordCount('thriller', 135_000)).toMatchObject({ status: 'very-long' })
    expect(checkWordCount('unknown-genre', 90_000)).toMatchObject({ status: 'unknown' })
  })
  it('uses the debut range when asked and one exists', () => {
    expect(checkWordCount('commercial', 72_000).status).toBe('short')
    expect(checkWordCount('commercial', 72_000, { debut: true }).status).toBe('within')
    // A genre without a debut range falls back to its typical range.
    expect(checkWordCount('thriller', 90_000, { debut: true }).status).toBe('within')
  })
})
