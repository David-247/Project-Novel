import { describe, expect, it } from 'vitest'
import { addCounts, appendParagraph, countText, createTally, isWordToken, summarizeParagraph, ZERO_COUNTS } from './word-count'

/** Counts of one paragraph of plain text. */
const words = (text: string) => countText(text).words

describe('word rules (Word-compatible, docs/word-count.md)', () => {
  it('counts runs of non-space characters', () => {
    expect(words('The quick brown fox')).toBe(4)
    expect(words('  leading and trailing  ')).toBe(3)
    expect(words('')).toBe(0)
    expect(words('   ')).toBe(0)
  })

  it('counts a hyphenated word as one', () => {
    expect(words('a well-known mother-in-law')).toBe(3)
    expect(words('twenty-one')).toBe(1)
  })

  it('joins the neighbours of an unspaced em or en dash', () => {
    expect(words('She waited—nothing came.')).toBe(3)
    expect(words('pages 10–12')).toBe(2)
  })

  it('counts a spaced dash, and any punctuation standing alone, as no word', () => {
    expect(words('She waited — nothing came.')).toBe(4)
    expect(words('wait - what')).toBe(2)
    expect(words('“ ” … ! ? * * *')).toBe(0)
    expect(words('Tom & Jerry')).toBe(2)
  })

  it('counts numbers as words', () => {
    expect(words('In 1902 she paid 1,250.50 for 3 horses')).toBe(8)
    expect(words('42')).toBe(1)
    expect(words('$5 or 10%')).toBe(3)
  })

  it('keeps contractions, possessives, slashes and ellipses inside one word', () => {
    expect(words("don't Anna's and/or wait...what")).toBe(4)
  })

  it('treats every Unicode space (no-break, thin, ideographic), tab and line break as a separator', () => {
    expect(words('10 kg')).toBe(2)
    expect(words('a b　c\td\ne')).toBe(5)
  })

  it('counts letters of any script, and digits of any script', () => {
    expect(words('café naïve Ελλάδα Москва')).toBe(4)
    expect(words('٣ ४')).toBe(2)
  })

  it('isWordToken: a token with a letter or digit', () => {
    expect(isWordToken('—')).toBe(false)
    expect(isWordToken('"Hello,"')).toBe(true)
    expect(isWordToken('#1')).toBe(true)
  })
})

describe('character rules', () => {
  it('counts characters with and without spaces; line breaks are not characters', () => {
    expect(countText('Hi there')).toEqual({ words: 2, charactersNoSpaces: 7, charactersWithSpaces: 8, paragraphs: 1 })
    expect(countText('a\nb')).toMatchObject({ charactersNoSpaces: 2, charactersWithSpaces: 2 })
    expect(countText('a\tb')).toMatchObject({ charactersNoSpaces: 2, charactersWithSpaces: 3 })
  })

  it('counts code points, not UTF-16 units', () => {
    expect(countText('𝔄 b')).toMatchObject({ charactersNoSpaces: 2, charactersWithSpaces: 3 })
  })

  it('a paragraph with only spaces is not a paragraph', () => {
    expect(countText('   ').paragraphs).toBe(0)
    expect(countText('').paragraphs).toBe(0)
    expect(countText('—').paragraphs).toBe(1)
  })
})

describe('paragraph tally and joins (an accepted paragraph-mark deletion)', () => {
  const tally = (parts: [string, boolean][]) => {
    const t = createTally()
    for (const [text, joins] of parts) appendParagraph(t, summarizeParagraph(text), joins)
    return t.counts
  }

  it('adds separate paragraphs', () => {
    expect(tally([['one two', false], ['three', false], ['', false]])).toEqual({ words: 3, charactersNoSpaces: 11, charactersWithSpaces: 12, paragraphs: 2 })
  })

  it('a joined paragraph glues its first word to the last word of the paragraph before', () => {
    // "fo" + "ar" -> "foar": one word, one paragraph.
    expect(tally([['fo', false], ['ar', true]])).toMatchObject({ words: 1, paragraphs: 1, charactersNoSpaces: 4 })
    expect(tally([['one fo', false], ['ar two', true]])).toMatchObject({ words: 3, paragraphs: 1 })
  })

  it('a join after a trailing space, or before a leading one, glues nothing', () => {
    expect(tally([['one ', false], ['two', true]])).toMatchObject({ words: 2, paragraphs: 1 })
    expect(tally([['one', false], [' two', true]])).toMatchObject({ words: 2, paragraphs: 1 })
  })

  it('punctuation joined to a word makes one word; punctuation joined to punctuation makes none', () => {
    expect(tally([['word', false], ['—', true]])).toMatchObject({ words: 1 })
    expect(tally([['—', false], ['word', true]])).toMatchObject({ words: 1 })
    expect(tally([['“', false], ['”', true]])).toMatchObject({ words: 0, paragraphs: 1 })
  })

  it('chains of joins keep gluing through single-token paragraphs', () => {
    expect(tally([['a', false], ['b', true], ['c', true]])).toMatchObject({ words: 1, paragraphs: 1 })
    expect(tally([['x a', false], ['b', true], ['c y', true]])).toMatchObject({ words: 3, paragraphs: 1 })
  })

  it('a joining paragraph whose text is all deleted goes away (no paragraph, nothing glued)', () => {
    expect(tally([['one', false], ['', true], ['two', false]])).toMatchObject({ words: 2, paragraphs: 2 })
  })

  it('joining onto an empty paragraph makes it one paragraph', () => {
    expect(tally([['', false], ['text', true]])).toMatchObject({ words: 1, paragraphs: 1 })
  })

  it('the first paragraph has nothing to join to: it stays a paragraph of its own', () => {
    expect(tally([['first', true], ['second', false]])).toMatchObject({ words: 2, paragraphs: 2 })
  })
})

describe('count arithmetic', () => {
  it('addCounts adds field by field', () => {
    expect(addCounts(countText('a b'), countText('c'))).toEqual({ words: 3, charactersNoSpaces: 3, charactersWithSpaces: 4, paragraphs: 2 })
    expect(addCounts(ZERO_COUNTS, ZERO_COUNTS)).toEqual(ZERO_COUNTS)
  })
})
