// Public interface of the "spellcheck" slice (Phase 5): the offline spell and grammar engine.
// Other slices import ONLY from here. docs/project-format.md, "dictionary.json".
//
// Harper (harper-core, Rust, src-tauri/src/spellcheck.rs) checks plain-text blocks on the blocking pool
// and returns findings with UTF-16 offsets. The dialect follows the OS locale (en-GB: British, else US).
//
// - checkBlocks(blocks): Promise<Map<blockId, Finding[]>>. Unchanged text is answered from a cache keyed by
//   the text's hash plus the dictionary version; only changed blocks go to Rust (one call). Findings the
//   writer ignored (ignoreOnce) are left out.
// - addWord(word, 'user' | 'project'): the user dictionary is preferences.json `spellcheck.words`, the
//   project's is the dictionary.json side file. dictionaryWords() lists both.
// - registerDictionarySideFile() once at start (composition root).
export type { Finding, Block, DictionaryScope } from './types'
export { addWord, removeWord, ignoreOnce, isIgnored, dictionaryWords, dictionaryVersion, normalizeWord } from './dictionary'
export { createFindingCache, type FindingCache } from './cache'
export { registerDictionarySideFile, DICTIONARY_FILE } from './persistence'

export { checkBlocks, __resetSpellcheckCacheForTests } from './check'

// The text a block is checked as (No Markup: tracked deletions and footnote references out, a hard break
// as '\n') and the way back to document positions, for callers that check text themselves (the tutor's
// check_spelling). hashText(text) is the block key checkBlocks and Ignore Once use for that text.
export { blockCheckText, textRangeToDoc } from './block-text'
export type { CheckText, TextSegment } from './block-text'
export { hashText } from './hash'

// The editor's underlines (Phase 5). createSpellcheckExtension(): pass to <NovelEditor extensions>
// (composition root); it checks the blocks in view and changed blocks 400 ms after the last edit or
// scroll, at most 200 per engine call, and underlines with `spell-error` / `grammar-error`.
// getFindingsInRange(from, to): the underlined findings there, with their document range and blockKey.
// registerSpellcheckMenu(): the context menu's suggestions, Ignore Once and Add to Dictionary.
// registerSpellcheckCommands(): View ▸ Spelling & Grammar (preferences `spellcheck.enabled`).
export { createSpellcheckExtension, getFindingsInRange, SPELL_CHECK_DEBOUNCE_MS, SPELL_CHECK_CHUNK, wordKey } from './extension'
export type { LocatedFinding } from './extension'
export { registerSpellcheckMenu, registerSpellcheckCommands, spellcheckCommands, toggleSpellcheck } from './menu'
export { SPELLCHECK_CONTROLS } from './controls'
export type { SpellcheckControlMeta, SpellcheckControlKey } from './controls'
