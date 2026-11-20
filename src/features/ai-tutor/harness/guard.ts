/**
 * The no-prose guard (design, "The no-prose guard"; decision 6a07d777). It is the only code guard of
 * the tutor, and it applies only to AI output that would enter the manuscript: `propose_change` and the
 * suggestions of `list_corrections` (output-tools.ts). Chat text is not filtered, and a Fix the writer
 * applies from their own spell checker (a Harper finding) does not pass through here.
 *
 * ## What "mechanical" means, exactly
 *
 * `checkMechanical(original, revised)` compares two texts as a word-level diff:
 *
 * 1. **Formatting.** When `revised === original` (character for character), the change can only be a
 *    formatting one (a paragraph style): `{ ok: true, kind: 'formatting' }`. Always allowed.
 * 2. **Tokens.** Both texts are cut into tokens: a *word* is a run of letters and digits, with inner
 *    apostrophes or hyphens (`don't`, `well-known`, `Paul’s`); every other non-space character is a
 *    *punctuation* token on its own. Whitespace is not a token.
 * 3. **Diff.** The token lists are diffed (longest common subsequence, a kept word weighing twice a
 *    kept punctuation mark). Each hunk (a maximal run of
 *    removed and added tokens between unchanged ones) changes `max(words removed, words added)` words:
 *    a replaced word counts 1, an inserted or deleted word 1 each. Punctuation tokens count 0, so
 *    adding a comma, or straight quotes made curly, change no words. A hunk belongs to the sentence of
 *    the original holding its first token (an insertion: the token before it).
 * 4. **Sentences.** `splitSentences` cuts the texts (rules below). It rejects, in this order:
 *    - `added_sentence`: the revision has more sentences than the original (an appended sentence, a
 *      sentence split in two, a line break added), or it has a *fresh* sentence (one with words, none
 *      of them kept from the original by the diff) that no *lost* original sentence (one with words,
 *      none of them kept) accounts for: more fresh sentences than lost ones. So two sentences merged
 *      to make room for a new one is caught, while a merge alone, or a one-word sentence with its typo
 *      fixed (`Yse.` → `Yes.`: one fresh, one lost), passes. Splitting a run-on sentence is explained
 *      in chat.
 *    - `too_many_words`: some sentence has more than `GUARD_LIMITS.wordsPerSentence` changed words.
 *    - `passage_fraction`: the changed words of the whole text exceed
 *      `max(wordsPerSentence, passageFraction × the original's words)`, where for several paragraphs
 *      (`checkPassage`) only the paragraphs whose text changed count, words and changes alike: unchanged
 *      paragraphs cannot dilute a rewrite (ruling R12 sets the floor). The floor keeps a short passage
 *      (one sentence of four words) from failing on a single typo; a passage can always take what one
 *      sentence may.
 *    Otherwise `{ ok: true, kind: 'mechanical' }`.
 *
 * ## Sentences
 *
 * A sentence ends after `.`, `!`, `?`, `‽`, `…` or `...` (any run of them), plus any closing quotes or
 * brackets, when whitespace or the end of the text follows, except:
 * - the next word starts with a lowercase letter (`"Run!" she cried`, `I thought… maybe`), unless the
 *   stop is a bare `.` (no closing quote): `It rained. the sun…` is two sentences missing a capital;
 * - the stop is a single `.` after an abbreviation (`Mr.`, `Dr.`, `St.`, `vs.`, …) or after initials
 *   and dotted forms (`J.`, `e.g.`, `U.S.`).
 * A line break always ends a sentence. Em and en dashes never do. Decimals (`3.50`) have no space after
 * the point, so they never end one.
 *
 * All thresholds live in `GUARD_LIMITS`, and nowhere else.
 */

export const GUARD_LIMITS = { wordsPerSentence: 3, passageFraction: 0.15 } as const

export type GuardResult = { ok: true; kind: 'mechanical' | 'formatting' } | { ok: false; reason: 'too_many_words' | 'added_sentence' | 'passage_fraction' }

/** Abbreviations whose `.` does not end a sentence (lowercase, without the point). */
const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'mx', 'dr', 'prof', 'sr', 'jr', 'st', 'mt', 'ft', 'vs', 'cf', 'al', 'approx', 'dept', 'est', 'fig', 'vol', 'no', 'nos', 'pp',
  'inc', 'ltd', 'co', 'corp', 'capt', 'col', 'gen', 'lt', 'sgt', 'cmdr', 'gov', 'rev', 'hon', 'fr', 'messrs', 'mme', 'mlle',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
])

const TERMINAL = /[.!?‽…]/
const CLOSER = /["'”’)\]»›]/
const SPACE = /\s/

/** Whether the `.` at `dot` follows an abbreviation or initials. */
function isAbbreviation(text: string, dot: number): boolean {
  let a = dot
  while (a > 0 && !SPACE.test(text[a - 1])) a--
  const word = text.slice(a, dot).replace(/^["'“‘([«‹]+/, '')
  if (!word) return false
  if (ABBREVIATIONS.has(word.toLowerCase())) return true
  // Initials and dotted forms: "J", "e.g", "U.S".
  return /^\p{L}(\.\p{L})*$/u.test(word)
}

/** The sentences of `text`, trimmed, in order (empty ones left out). See the module comment. */
export function splitSentences(text: string): string[] {
  const out: string[] = []
  let start = 0
  const push = (end: number) => {
    const s = text.slice(start, end).trim()
    if (s) out.push(s)
    start = end
  }
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch === '\n') {
      push(i)
      i++
      continue
    }
    if (!TERMINAL.test(ch)) {
      i++
      continue
    }
    const stop = i
    while (i < text.length && TERMINAL.test(text[i])) i++
    const run = text.slice(stop, i)
    const closed = i
    while (i < text.length && CLOSER.test(text[i])) i++
    if (i < text.length && !SPACE.test(text[i])) continue // "3.50", "end.)word"
    let next = i
    while (next < text.length && SPACE.test(text[next]) && text[next] !== '\n') next++
    const following = text[next]
    // A lowercase word goes on the sentence ("Run!" she cried), except after a bare full stop, where it is
    // a missing capital ("It rained. the sun…"): fixing that capital must not count as a new sentence.
    const bareStop = run === '.' && i === closed
    if (!bareStop && following !== undefined && following !== '\n' && /\p{Ll}/u.test(following)) continue
    if (run === '.' && isAbbreviation(text, stop)) continue
    push(i)
  }
  push(text.length)
  return out
}

interface Token {
  text: string
  word: boolean
  /** The sentence (index into splitSentences) holding the token. */
  sentence: number
}

const TOKEN = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*|\S/gu

/** Tokens of `text`, each with the index of its sentence. */
function tokenize(text: string): { tokens: Token[]; sentences: number } {
  const sentences = splitSentences(text)
  const tokens: Token[] = []
  sentences.forEach((s, n) => {
    for (const m of s.matchAll(TOKEN)) tokens.push({ text: m[0], word: /[\p{L}\p{N}]/u.test(m[0]), sentence: n })
  })
  return { tokens, sentences: sentences.length }
}

type Op = { kind: 'same' | 'del' | 'add'; a: number; b: number }

/**
 * An edit script from `a` to `b`: a longest common subsequence where a kept word weighs more than a kept
 * punctuation mark (so `barked` stays aligned rather than a full stop elsewhere), with the common prefix
 * and suffix trimmed first.
 */
function diff(a: readonly Token[], b: readonly Token[]): Op[] {
  let pre = 0
  while (pre < a.length && pre < b.length && a[pre].text === b[pre].text) pre++
  let suf = 0
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf].text === b[b.length - 1 - suf].text) suf++
  const n = a.length - pre - suf
  const m = b.length - pre - suf
  const weight = (t: Token) => (t.word ? 2 : 1)
  const same = (i: number, j: number) => a[pre + i].text === b[pre + j].text
  // lcs[i][j]: the best weight of a[pre+i..] and b[pre+j..] within the middle.
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) lcs[i][j] = Math.max(lcs[i + 1][j], lcs[i][j + 1], same(i, j) ? lcs[i + 1][j + 1] + weight(a[pre + i]) : 0)
  const ops: Op[] = []
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

interface Analysis {
  total: number
  perSentence: number[]
  words: number
  /** Revised sentences with words, none of them kept from the original. */
  fresh: number
  /** Original sentences with words, none of them kept in the revision. */
  lost: number
}

/** Sentences of `tokens` (`count` of them) that have words but none of them in `kept`. */
function sentencesWithoutKept(tokens: readonly Token[], count: number, kept: ReadonlySet<number>): number {
  const hasWord = Array<boolean>(count).fill(false)
  const hasKept = Array<boolean>(count).fill(false)
  tokens.forEach((t, i) => {
    if (!t.word) return
    hasWord[t.sentence] = true
    if (kept.has(i)) hasKept[t.sentence] = true
  })
  return hasWord.filter((w, i) => w && !hasKept[i]).length
}

function analyze(original: string, revised: string): Analysis {
  const a = tokenize(original)
  const b = tokenize(revised)
  const perSentence = Array<number>(a.sentences).fill(0)
  const ops = diff(a.tokens, b.tokens)
  const keptA = new Set(ops.filter((o) => o.kind === 'same').map((o) => o.a))
  const keptB = new Set(ops.filter((o) => o.kind === 'same').map((o) => o.b))
  const fresh = sentencesWithoutKept(b.tokens, b.sentences, keptB)
  const lost = sentencesWithoutKept(a.tokens, a.sentences, keptA)
  let total = 0
  for (let k = 0; k < ops.length; ) {
    if (ops[k].kind === 'same') {
      k++
      continue
    }
    let removed = 0
    let added = 0
    let first = -1
    const anchor = ops[k].a
    for (; k < ops.length && ops[k].kind !== 'same'; k++) {
      const op = ops[k]
      if (op.kind === 'del') {
        if (first < 0) first = op.a
        if (a.tokens[op.a].word) removed++
      } else if (b.tokens[op.b].word) added++
    }
    const changed = Math.max(removed, added)
    if (!changed) continue
    total += changed
    // The sentence of the hunk's first original token; an insertion belongs with the token before it.
    const at = first >= 0 ? first : Math.max(0, anchor - 1)
    const sentence = a.tokens[at]?.sentence ?? 0
    if (perSentence.length) perSentence[sentence] += changed
    else perSentence.push(changed)
  }
  return { total, perSentence, words: a.tokens.filter((t) => t.word).length, fresh, lost }
}

/**
 * The changed words of `revised` against `original` (step 3 of the module comment): in total, per
 * sentence of the original, and the original's word count.
 */
export function countChangedWords(original: string, revised: string): { total: number; perSentence: number[]; words: number } {
  const { total, perSentence, words } = analyze(original, revised)
  return { total, perSentence, words }
}

/** Whether `revised` is a mechanical (or formatting-only) change of `original`. See the module comment. */
export function checkMechanical(original: string, revised: string): GuardResult {
  return checkPassage([original], [revised])
}

/**
 * `checkMechanical` for a passage of several paragraphs (`revised[i]` replaces `original[i]`): the
 * sentence rules hold in each paragraph (a sentence moved into the next paragraph is an added one), and
 * the passage fraction counts the changed paragraphs together (unchanged ones are left out, so padding
 * a rewrite with untouched paragraphs cannot dilute it). Formatting only when every paragraph is
 * unchanged.
 */
export function checkPassage(original: readonly string[], revised: readonly string[]): GuardResult {
  if (original.length !== revised.length) throw new Error('checkPassage: one revised text per paragraph')
  if (original.every((o, i) => o === revised[i])) return { ok: true, kind: 'formatting' }
  const changed = original.map((o, i) => ({ o, r: revised[i] })).filter(({ o, r }) => o !== r)
  const analyses = changed.map(({ o, r }) => ({ c: analyze(o, r), more: splitSentences(r).length > splitSentences(o).length }))
  if (analyses.some(({ c, more }) => more || c.fresh > c.lost)) return { ok: false, reason: 'added_sentence' }
  let total = 0
  let words = 0
  for (const { c } of analyses) {
    if (c.perSentence.some((n) => n > GUARD_LIMITS.wordsPerSentence)) return { ok: false, reason: 'too_many_words' }
    total += c.total
    words += c.words
  }
  if (total > Math.max(GUARD_LIMITS.wordsPerSentence, GUARD_LIMITS.passageFraction * words)) return { ok: false, reason: 'passage_fraction' }
  return { ok: true, kind: 'mechanical' }
}
