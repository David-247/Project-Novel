/**
 * TEST-ONLY stand-in for the Rust spell checker (src-tauri/src/spellcheck.rs), part of the fake Tauri
 * core (./fake-tauri-core.ts). It is not Harper: it flags the words in `state.misspellings` (default
 * "teh" -> "the") as spelling findings, with UTF-16 offsets like Rust, unless the word is in the
 * dictionary the caller sent (case-insensitive), and each phrase of `state.grammar` (none by default) as a
 * grammar finding. Every call is recorded in `state.calls`.
 */

export const SPELL_COMMAND_NAMES = ['spell_check'] as const

export interface FakeSpellCall {
  blocks: { id: string; text: string }[]
  words: string[]
  locale: string | null
}

export function createFakeSpell() {
  const state = {
    calls: [] as FakeSpellCall[],
    /** Misspelled word (lowercase) -> its suggestions. */
    misspellings: new Map<string, string[]>([['teh', ['the']]]),
    /** Phrase (exact, case-sensitive) -> its suggestions, reported as grammar findings. */
    grammar: new Map<string, string[]>(),
    /** Make the command fail (the engine could not start). */
    fail: false,
  }

  function reset(): void {
    state.calls.length = 0
    state.misspellings = new Map([['teh', ['the']]])
    state.grammar = new Map()
    state.fail = false
  }

  async function handle(_cmd: string, args: Record<string, unknown>): Promise<unknown> {
    const call: FakeSpellCall = {
      blocks: args.blocks as FakeSpellCall['blocks'],
      words: args.words as string[],
      locale: (args.locale as string | null | undefined) ?? null,
    }
    state.calls.push(call)
    if (state.fail) throw 'The spell check stopped unexpectedly.'
    const custom = new Set(call.words.map((w) => w.toLowerCase()))
    return call.blocks.map((b) => {
      const spelling = [...b.text.matchAll(/[A-Za-z]+/g)].flatMap((m) => {
        const word = m[0].toLowerCase()
        const suggestions = state.misspellings.get(word)
        if (!suggestions || custom.has(word)) return []
        return [
          { start: m.index, end: m.index + m[0].length, kind: 'spelling', rule: 'SpellCheck', message: 'Did you mean a different word?', suggestions },
        ]
      })
      const grammar = [...state.grammar].flatMap(([phrase, suggestions]) => {
        const out = []
        for (let i = b.text.indexOf(phrase); i >= 0; i = b.text.indexOf(phrase, i + 1))
          out.push({ start: i, end: i + phrase.length, kind: 'grammar', rule: 'AnA', message: 'Use a different article.', suggestions })
        return out
      })
      return { id: b.id, findings: [...spelling, ...grammar].sort((x, y) => x.start - y.start) }
    })
  }

  return { state, handle, reset }
}
