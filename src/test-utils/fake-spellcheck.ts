/**
 * TEST-ONLY stand-in for the Rust spell checker (src-tauri/src/spellcheck.rs), part of the fake Tauri
 * core (./fake-tauri-core.ts). It is not Harper: it flags the words in `state.misspellings` (default
 * "teh" -> "the") as spelling findings, with UTF-16 offsets like Rust, unless the word is in the
 * dictionary the caller sent (case-insensitive). Every call is recorded in `state.calls`.
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
    /** Make the command fail (the engine could not start). */
    fail: false,
  }

  function reset(): void {
    state.calls.length = 0
    state.misspellings = new Map([['teh', ['the']]])
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
    return call.blocks.map((b) => ({
      id: b.id,
      findings: [...b.text.matchAll(/[A-Za-z]+/g)].flatMap((m) => {
        const word = m[0].toLowerCase()
        const suggestions = state.misspellings.get(word)
        if (!suggestions || custom.has(word)) return []
        return [
          { start: m.index, end: m.index + m[0].length, kind: 'spelling', rule: 'SpellCheck', message: 'Did you mean a different word?', suggestions },
        ]
      }),
    }))
  }

  return { state, handle, reset }
}
