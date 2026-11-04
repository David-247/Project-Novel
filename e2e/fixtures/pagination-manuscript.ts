/**
 * Deterministic ~100,000-word manuscript for pagination tests (perf and cross-engine fixture):
 * `chapters` chapters, each a level-1 heading followed by paragraphs of varied length (dialogue
 * lines, long narrative paragraphs), with some italic and bold runs. The same seed always gives
 * the same document, so page counts can be compared across engines and runs.
 */

/** mulberry32: small, fast, deterministic PRNG. */
function prng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const VOCAB = (
  'the a and of to in was he she it that his her had with for on at as but they not from by an ' +
  'one were said all would there their what so up out if about who them which when could been ' +
  'night river quiet lantern stone window garden letter morning shadow silver harbor whisper meadow ' +
  'candle thunder orchard ribbon compass feather journey kitchen mountain doorway evening stranger ' +
  'remembered carefully suddenly through without another against between beneath somewhere afterwards ' +
  'extraordinary understanding conversation photograph possibility neighbourhood circumstances ' +
  'cold old long small bright dark heavy narrow distant gentle restless hollow'
).split(' ')

export interface PaginationFixture {
  doc: { type: 'doc'; content: unknown[] }
  words: number
  chapters: number
}

export function buildPaginationFixture({ words = 100_000, chapters = 30, seed = 20261103 } = {}): PaginationFixture {
  const rnd = prng(seed)
  const pick = () => VOCAB[Math.floor(rnd() * VOCAB.length)]
  const content: unknown[] = []
  const perChapter = Math.floor(words / chapters)
  let total = 0
  for (let c = 0; c < chapters; c++) {
    const title = `Chapter ${c + 1}: The ${pick()} ${pick()}`
    content.push({ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: title }] })
    total += title.split(' ').length
    const target = c === chapters - 1 ? words - total : perChapter * (c + 1) - total
    let inChapter = 0
    while (inChapter < target) {
      const r = rnd()
      // Dialogue (short), ordinary, or long paragraphs.
      let len = r < 0.25 ? 4 + Math.floor(rnd() * 14) : r < 0.85 ? 30 + Math.floor(rnd() * 90) : 120 + Math.floor(rnd() * 140)
      len = Math.min(len, target - inChapter)
      if (len <= 0) break
      const w = Array.from({ length: len }, pick)
      w[0] = w[0][0].toUpperCase() + w[0].slice(1)
      const text = w.join(' ') + '.'
      const runs: unknown[] = []
      if (len > 20 && rnd() < 0.3) {
        const cut = 5 + Math.floor(rnd() * (len - 10))
        const before = w.slice(0, cut).join(' ') + ' '
        const em = w.slice(cut, cut + 3).join(' ')
        const after = ' ' + w.slice(cut + 3).join(' ') + '.'
        runs.push({ type: 'text', text: before }, { type: 'text', marks: [{ type: rnd() < 0.7 ? 'italic' : 'bold' }], text: em }, { type: 'text', text: after })
      } else runs.push({ type: 'text', text: r < 0.25 ? `“${text}”` : text })
      content.push({ type: 'paragraph', content: runs })
      inChapter += len
    }
    total += inChapter
  }
  return { doc: { type: 'doc', content }, words: total, chapters }
}
