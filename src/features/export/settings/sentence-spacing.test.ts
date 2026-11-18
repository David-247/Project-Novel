import { describe, expect, it } from 'vitest'
import { classicSentenceSpacing, doubleSentenceSpaces } from './sentence-spacing'

describe('Classic sentence spacing (both generators)', () => {
  it('two spaces after a sentence', () => {
    expect(doubleSentenceSpaces('It rained. She left! Did he? Yes.')).toBe('It rained.  She left!  Did he?  Yes.')
    expect(doubleSentenceSpaces('"Go." He went. (Later.) "Why?" she asked.')).toBe('"Go."  He went.  (Later.)  "Why?" she asked.')
    expect(doubleSentenceSpaces('“Go.” He went… Then 3 more.')).toBe('“Go.”  He went…  Then 3 more.')
  })

  it('not after an abbreviation, an initial, or before lower case', () => {
    expect(doubleSentenceSpaces('Mr. Smith met Dr. Jones and J. R. R. Tolkien. etc. ok')).toBe('Mr. Smith met Dr. Jones and J. R. R. Tolkien. etc. ok')
    expect(doubleSentenceSpaces('e.g. this. and that')).toBe('e.g. this. and that')
  })

  it('leaves spaces the writer already doubled (or tripled) alone', () => {
    expect(doubleSentenceSpaces('One.  Two.   Three.')).toBe('One.  Two.   Three.')
  })

  it('across runs: the end, the space and the next word may each be in another run', () => {
    expect(classicSentenceSpacing(['It ended.', ' Then'])).toEqual(['It ended.', '  Then'])
    expect(classicSentenceSpacing(['It ended.', ' then'])).toEqual(['It ended.', ' then'])
    expect(classicSentenceSpacing(['Mr.', ' Smith'])).toEqual(['Mr.', ' Smith'])
    expect(classicSentenceSpacing(['It was ', 'night', '.', ' She left.'])).toEqual(['It was ', 'night', '.', '  She left.'])
  })

  it('a run of only spaces: doubled only when a sentence starts after it (T6 minor)', () => {
    expect(classicSentenceSpacing(['night.', ' ', 'She'])).toEqual(['night.', '  ', 'She'])
    expect(classicSentenceSpacing(['night.', ' ', 'she'])).toEqual(['night.', ' ', 'she'])
    expect(classicSentenceSpacing(['Mr.', ' ', 'Smith'])).toEqual(['Mr.', ' ', 'Smith'])
    expect(classicSentenceSpacing(['   '])).toEqual(['   '])
  })

  it('a footnote reference keeps the sentence ended; a line break ends the context', () => {
    expect(classicSentenceSpacing(['night.', '', ' The rain'])).toEqual(['night.', '', '  The rain'])
    expect(classicSentenceSpacing(['night.', null, ' The rain'])).toEqual(['night.', null, ' The rain'])
    expect(classicSentenceSpacing(['One. Two.', null, 'Three. Four'])).toEqual(['One.  Two.', null, 'Three.  Four'])
  })

  it('stays linear on a very long paragraph, in one run or in many (timing guard)', () => {
    const sentence = 'Mr. Smith walked to the river and back. '
    const long = sentence.repeat(10_000) // 400,000 characters, 10,000 sentence gaps
    const t0 = performance.now()
    const out = doubleSentenceSpaces(long)
    const many = classicSentenceSpacing(Array.from({ length: 10_000 }, () => sentence))
    const ms = performance.now() - t0
    expect(out.startsWith('Mr. Smith walked to the river and back.  Mr. Smith')).toBe(true)
    expect(out.length).toBe(long.length + 9_999)
    expect(many.join('')).toBe(out)
    expect(ms).toBeLessThan(1000)
  })
})
