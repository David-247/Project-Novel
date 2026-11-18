import { describe, expect, it } from 'vitest'
import { doubleSentenceSpaces, sentenceContext, xmlSafe } from './text'

describe('xmlSafe', () => {
  it('drops what XML 1.0 cannot hold and keeps tab, line feeds and emoji', () => {
    expect(xmlSafe('a\u0000b\u0001c\u0008d\u000Be\u000Cf\u001Fg￾h￿i')).toBe('abcdefghi')
    expect(xmlSafe('tab\tlf\ncr\r')).toBe('tab\tlf\ncr\r')
    expect(xmlSafe('😀 👩‍👩‍👧 é')).toBe('😀 👩‍👩‍👧 é')
    expect(xmlSafe('lone \uD800 high, lone \uDC00 low')).toBe('lone  high, lone  low')
    expect(xmlSafe('& < > " \'')).toBe('& < > " \'') // escaping is the docx library's job
  })
})

describe('doubleSentenceSpaces (Classic)', () => {
  it('two spaces after a sentence', () => {
    expect(doubleSentenceSpaces('It rained. She left! Did he? Yes.')).toBe('It rained.  She left!  Did he?  Yes.')
    expect(doubleSentenceSpaces('"Go." He went. (Later.) "Why?" she asked.')).toBe('"Go."  He went.  (Later.)  "Why?" she asked.')
    expect(doubleSentenceSpaces('“Go.” He went… Then 3 more.')).toBe('“Go.”  He went…  Then 3 more.')
  })

  it('not after an abbreviation, an initial, or before lower case', () => {
    expect(doubleSentenceSpaces('Mr. Smith met Dr. Jones and J. R. R. Tolkien. etc. ok')).toBe('Mr. Smith met Dr. Jones and J. R. R. Tolkien. etc. ok')
    expect(doubleSentenceSpaces('e.g. this. and that')).toBe('e.g. this. and that')
  })

  it('across runs: a space starting this run after a sentence ending the previous one', () => {
    expect(doubleSentenceSpaces(' Then', 'It ended.')).toBe('  Then')
    expect(doubleSentenceSpaces(' then', 'It ended.')).toBe(' then')
    expect(doubleSentenceSpaces(' Smith', 'Mr.')).toBe(' Smith')
  })

  it('stays linear on a very long paragraph, in one run or in many (timing guard)', () => {
    const sentence = 'Mr. Smith walked to the river and back. '
    const long = sentence.repeat(10_000) // 400,000 characters, 10,000 sentence gaps
    const t0 = performance.now()
    const out = doubleSentenceSpaces(long)
    let previous = ''
    for (let i = 0; i < 10_000; i++) {
      doubleSentenceSpaces(sentence, previous)
      previous = sentenceContext(previous + sentence)
    }
    const ms = performance.now() - t0
    expect(out.startsWith('Mr. Smith walked to the river and back.  Mr. Smith')).toBe(true)
    expect(out.length).toBe(long.length + 9_999)
    expect(ms).toBeLessThan(1000)
  })

  it('leaves existing double spaces alone', () => {
    expect(doubleSentenceSpaces('One.  Two.')).toBe('One.  Two.')
  })
})
