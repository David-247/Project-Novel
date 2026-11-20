import { describe, expect, it } from 'vitest'
import { checkMechanical, checkPassage, countChangedWords, GUARD_LIMITS, splitSentences } from './guard'

/** Ten five-word sentences. */
const PASSAGE = Array.from({ length: 10 }, (_, i) => `Dog ${i + 1} ran past here.`).join(' ')

describe('GUARD_LIMITS', () => {
  it('holds the thresholds of the brief', () => {
    expect(GUARD_LIMITS).toEqual({ wordsPerSentence: 3, passageFraction: 0.15 })
  })
})

describe('checkMechanical', () => {
  const allowed: [string, string, string, 'mechanical' | 'formatting'][] = [
    ['a typo ("teh" to "the")', 'I saw teh dog.', 'I saw the dog.', 'mechanical'],
    ['an added comma', 'However the rain kept falling.', 'However, the rain kept falling.', 'mechanical'],
    ['"their" to "there"', 'Put the box over their.', 'Put the box over there.', 'mechanical'],
    ['a paragraph-style change (the text unchanged)', 'Chapter One', 'Chapter One', 'formatting'],
    ['three words in one sentence', 'Me and him goes to the shop.', 'He and I go to the shop.', 'mechanical'],
    ['curly quotes for straight ones', 'He said "no" and left.', 'He said “no” and left.', 'mechanical'],
    ['a capital at the start of a sentence', 'It rained. the sun came out.', 'It rained. The sun came out.', 'mechanical'],
    ['a fix in dialogue with a tag', '"Stop!" she said. "Your to late."', '"Stop!" she said. "You\'re too late."', 'mechanical'],
    ['10 % of a passage, one word per sentence', PASSAGE, PASSAGE.replace(/(Dog [1-5] ran) past/g, '$1 passed'), 'mechanical'],
  ]
  it.each(allowed)('allows %s', (_name, original, revised, kind) => {
    expect(checkMechanical(original, revised)).toEqual({ ok: true, kind })
  })

  const tenFixes = PASSAGE.replace(/ past /g, ' passed ')
  const rejected: [string, string, string, 'too_many_words' | 'added_sentence' | 'passage_fraction'][] = [
    ['the same sentence reworded with 5 new words', 'The rain fell on the town all night.', 'The storm battered the sleeping village all night.', 'too_many_words'],
    ['four words changed in one sentence', 'Me and him goes to the shop.', 'He and I went towards the shop.', 'too_many_words'],
    ['an extra sentence appended', 'I saw the dog.', 'I saw the dog. It barked.', 'added_sentence'],
    ['a sentence split in two', 'I saw the dog and it barked.', 'I saw the dog. It barked.', 'added_sentence'],
    ['a line break inserted', 'I saw the dog and it barked.', 'I saw the dog\nand it barked.', 'added_sentence'],
    ['20 % of the words changed across a passage of 1-word fixes', PASSAGE, tenFixes, 'passage_fraction'],
    ['a sentence deleted', 'I saw the dog. It barked at the moon.', 'I saw the dog.', 'too_many_words'],
  ]
  it.each(rejected)('rejects %s', (_name, original, revised, reason) => {
    expect(checkMechanical(original, revised)).toEqual({ ok: false, reason })
  })

  it('counts the 20 % passage as 10 one-word fixes of 50 words', () => {
    expect(countChangedWords(PASSAGE, tenFixes)).toEqual({ total: 10, perSentence: Array(10).fill(1), words: 50 })
  })

  it('does not count punctuation or whitespace as words', () => {
    expect(countChangedWords('Well I never', 'Well, I  never!').total).toBe(0)
  })
})

describe('checkPassage (several paragraphs)', () => {
  it('is checkMechanical for one paragraph', () => {
    expect(checkPassage(['I saw teh dog.'], ['I saw the dog.'])).toEqual({ ok: true, kind: 'mechanical' })
    expect(checkPassage(['Chapter One'], ['Chapter One'])).toEqual({ ok: true, kind: 'formatting' })
  })

  it('rejects a sentence moved from one paragraph into another', () => {
    expect(checkPassage(['One. Two.', 'Three.'], ['One.', 'Two. Three.'])).toEqual({ ok: false, reason: 'added_sentence' })
  })

  it('applies the passage fraction to all the paragraphs together', () => {
    const paragraphs = Array.from({ length: 5 }, (_, i) => `Dog ${i + 1} ran past here. Dog ${i + 1} ran past there.`)
    expect(checkPassage(paragraphs, paragraphs.map((t) => t.replace(/ past here/, ' passed here')))).toEqual({ ok: true, kind: 'mechanical' })
    expect(checkPassage(paragraphs, paragraphs.map((t) => t.replace(/ past /g, ' passed ')))).toEqual({ ok: false, reason: 'passage_fraction' })
  })

  it('is formatting only when every paragraph is unchanged', () => {
    expect(checkPassage(['A.', 'B.'], ['A.', 'B.'])).toEqual({ ok: true, kind: 'formatting' })
    expect(checkPassage(['A cat.', 'B.'], ['A cat.', 'B!'])).toEqual({ ok: true, kind: 'mechanical' })
  })
})

describe('splitSentences', () => {
  const cases: [string, string, string[]][] = [
    ['plain sentences', 'One. Two! Three?', ['One.', 'Two!', 'Three?']],
    ['abbreviations', 'Mr. Smith met Dr. Jones at St. Paul’s. They talked.', ['Mr. Smith met Dr. Jones at St. Paul’s.', 'They talked.']],
    ['initials and e.g.', 'J. R. R. Tolkien wrote books, e.g. The Hobbit. He died.', ['J. R. R. Tolkien wrote books, e.g. The Hobbit.', 'He died.']],
    ['closing quotes after the stop', 'She said, “Go.” He went.', ['She said, “Go.”', 'He went.']],
    ['a dialogue tag after ! or ?', '"Run!" she cried. "Where?" he asked.', ['"Run!" she cried.', '"Where?" he asked.']],
    ['an ellipsis inside a sentence', 'I thought… maybe not. Then I left...', ['I thought… maybe not.', 'Then I left...']],
    ['an ellipsis ending a sentence', 'He waited... Nothing came.', ['He waited...', 'Nothing came.']],
    ['em dashes', 'She stopped—“Wait”—and turned. Silence.', ['She stopped—“Wait”—and turned.', 'Silence.']],
    ['a missing capital after a full stop', 'It rained. the sun came out.', ['It rained.', 'the sun came out.']],
    ['decimals', 'It cost 3.50 dollars. Cheap.', ['It cost 3.50 dollars.', 'Cheap.']],
    ['a line break', 'First line\nSecond line', ['First line', 'Second line']],
    ['no final stop', 'Chapter One', ['Chapter One']],
    ['empty', '   ', []],
  ]
  it.each(cases)('splits %s', (_name, text, expected) => {
    expect(splitSentences(text)).toEqual(expected)
  })
})
