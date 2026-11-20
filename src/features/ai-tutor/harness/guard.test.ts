import { describe, expect, it } from 'vitest'
import { __diffForTests, checkMechanical, checkPassage, countChangedWords, GUARD_LIMITS, splitSentences } from './guard'

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
    ['two sentences merged, no words added', 'I saw the dog. It barked.', 'I saw the dog, it barked.', 'mechanical'],
    ['a one-word sentence with its typo fixed', 'Yse. I agree.', 'Yes. I agree.', 'mechanical'],
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
    ['two sentences merged and a new one appended', 'I saw the dog. It barked.', 'I saw the dog, it barked. Run.', 'added_sentence'],
    ['a sentence replaced by a new one in front of a kept one', 'It barked. I ran.', 'Dogs bark loudly. It barked, I ran.', 'added_sentence'],
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

  it('counts only the changed paragraphs: padding a rewrite with unchanged ones does not dilute it', () => {
    const rewrite = Array.from({ length: 5 }, (_, i) => `Dog ${i + 1} ran past the house.`).join(' ')
    const revised = rewrite.replace(/ran past the/g, 'walked by a')
    expect(checkPassage([rewrite], [revised])).toEqual({ ok: false, reason: 'passage_fraction' })
    const filler = Array.from({ length: 10 }, (_, i) => `Cat ${i + 1} sat here.`).join(' ')
    expect(checkPassage([rewrite, filler, filler], [revised, filler, filler])).toEqual({ ok: false, reason: 'passage_fraction' })
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

describe('the diff behind the guard: memory (final B-M10)', () => {
  type Tok = { text: string; word: boolean; sentence: number }
  const toks = (s: string): Tok[] => s.split(' ').map((text) => ({ text, word: /\w/.test(text), sentence: 0 }))

  /** The full n × m table the guard used before: the reference for the same edit script. */
  function reference(a: readonly Tok[], b: readonly Tok[]) {
    let pre = 0
    while (pre < a.length && pre < b.length && a[pre].text === b[pre].text) pre++
    let suf = 0
    while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf].text === b[b.length - 1 - suf].text) suf++
    const n = a.length - pre - suf
    const m = b.length - pre - suf
    const weight = (t: Tok) => (t.word ? 2 : 1)
    const same = (i: number, j: number) => a[pre + i].text === b[pre + j].text
    const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--) lcs[i][j] = Math.max(lcs[i + 1][j], lcs[i][j + 1], same(i, j) ? lcs[i + 1][j + 1] + weight(a[pre + i]) : 0)
    const ops: { kind: string; a: number; b: number }[] = []
    for (let k = 0; k < pre; k++) ops.push({ kind: 'same', a: k, b: k })
    let i = 0
    let j = 0
    while (i < n || j < m) {
      if (i < n && j < m && same(i, j) && lcs[i][j] === lcs[i + 1][j + 1] + weight(a[pre + i])) ops.push({ kind: 'same', a: pre + i++, b: pre + j++ })
      else if (j < m && (i === n || lcs[i][j + 1] >= lcs[i + 1][j])) ops.push({ kind: 'add', a: pre + i, b: pre + j++ })
      else ops.push({ kind: 'del', a: pre + i++, b: pre + j })
    }
    for (let k = 0; k < suf; k++) ops.push({ kind: 'same', a: a.length - suf + k, b: b.length - suf + k })
    return ops
  }

  it('gives exactly the edit script of the full table, on many random texts', () => {
    let seed = 7
    const rand = (k: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed % k
    }
    const pool = ['the', 'dog', 'ran', ',', '.', 'a', 'cat', '!', 'sat']
    for (let run = 0; run < 300; run++) {
      const a = Array.from({ length: rand(40) }, () => pool[rand(pool.length)]).join(' ')
      const b = Array.from({ length: rand(40) }, () => pool[rand(pool.length)]).join(' ')
      const ta = a ? toks(a) : []
      const tb = b ? toks(b) : []
      expect(__diffForTests(ta, tb).ops, `${a} | ${b}`).toEqual(reference(ta, tb))
    }
  })

  it('holds only about √n rows of the table, so a long proposal cannot exhaust memory', () => {
    const a = toks(Array.from({ length: 4000 }, (_, i) => (i % 9 === 8 ? '.' : `w${i % 50}`)).join(' '))
    const b = toks(['first', ...a.slice(1).map((t) => t.text).slice(0, -1), 'last'].join(' '))
    const { ops, rowsHeld } = __diffForTests(a, b)
    expect(ops.filter((o) => o.kind !== 'same')).toHaveLength(4)
    // A full table would hold 4,001 rows of 4,001 cells (about 64 MB); this holds a small fraction.
    expect(rowsHeld).toBeLessThan(200)
  })

  it('a 20,000-character revision of a 20,000-character paragraph is judged as before', () => {
    const sentence = 'The old dog ran past the gate and on into the dark wood. '
    const original = sentence.repeat(Math.floor(20_000 / sentence.length))
    const revised = original.replace('The old dog', 'Teh old dog').replace(/wood\. $/, 'woods. ')
    expect(checkMechanical(original, revised)).toEqual({ ok: true, kind: 'mechanical' })
  })
})
