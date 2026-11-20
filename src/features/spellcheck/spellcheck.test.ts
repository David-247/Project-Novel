import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_DICTIONARY_WORDS, useStore } from '@/shared/store'
import { backend } from '@/test-utils/fake-tauri'

vi.mock('@tauri-apps/api/core', async () => (await import('@/test-utils/fake-tauri')).coreModule)

import { __resetIgnoredForTests } from './dictionary'
import {
  __resetSpellcheckCacheForTests,
  addWord,
  checkBlocks,
  createFindingCache,
  dictionaryVersion,
  dictionaryWords,
  ignoreOnce,
  removeWord,
  type Finding,
} from './index'

const finding = (over: Partial<Finding> = {}): Finding => ({ start: 0, end: 3, kind: 'spelling', rule: 'SpellCheck', message: 'm', suggestions: [], ...over })

beforeEach(() => {
  backend.reset()
  __resetSpellcheckCacheForTests()
  __resetIgnoredForTests()
  useStore.getState().preferencesActions.set('spellcheck', { enabled: true, words: [] })
  useStore.getState().spellcheckActions.loadProjectWords([])
})

describe('checkBlocks', () => {
  it('returns findings by block id with UTF-16 offsets from the engine', async () => {
    const found = await checkBlocks([{ id: 'a', text: 'I saw teh dog.' }, { id: 'b', text: 'Fine.' }])
    expect(found.get('a')).toMatchObject([{ start: 6, end: 9, kind: 'spelling', suggestions: ['the'] }])
    expect(found.get('b')).toEqual([])
    expect(backend.spell.calls).toHaveLength(1)
    expect(backend.spell.calls[0].locale).toBe(navigator.languages?.[0] ?? navigator.language ?? null)
  })

  it('answers unchanged text from the cache and sends only changed blocks', async () => {
    await checkBlocks([{ id: 'a', text: 'teh one' }, { id: 'b', text: 'two' }])
    await checkBlocks([{ id: 'a', text: 'teh one' }, { id: 'b', text: 'two' }])
    expect(backend.spell.calls).toHaveLength(1) // the second call never reached Rust
    await checkBlocks([{ id: 'a', text: 'teh one' }, { id: 'b', text: 'two, edited' }])
    expect(backend.spell.calls).toHaveLength(2)
    expect(backend.spell.calls[1].blocks.map((b) => b.text)).toEqual(['two, edited'])
  })

  it('checks identical text once per call and answers every block that holds it', async () => {
    const found = await checkBlocks([{ id: 'a', text: 'teh' }, { id: 'b', text: 'teh' }])
    expect(backend.spell.calls[0].blocks).toHaveLength(1)
    expect(found.get('a')).toHaveLength(1)
    expect(found.get('b')).toHaveLength(1)
  })

  it('misses after addWord and sends the dictionary', async () => {
    const blocks = [{ id: 'a', text: 'Aelinor teh' }]
    await checkBlocks(blocks)
    addWord('Aelinor', 'project')
    await checkBlocks(blocks)
    expect(backend.spell.calls).toHaveLength(2)
    expect(backend.spell.calls[1].words).toEqual(['Aelinor'])
    addWord('Zoë', 'user')
    await checkBlocks(blocks)
    expect(backend.spell.calls).toHaveLength(3)
    expect(backend.spell.calls[2].words).toEqual(['Zoë', 'Aelinor'])
  })

  it('a word added while a check runs does not poison the cache', async () => {
    const pending = checkBlocks([{ id: 'a', text: 'teh' }])
    addWord('teh', 'user') // the dictionary changes after the call was made
    await pending
    const found = await checkBlocks([{ id: 'a', text: 'teh' }])
    expect(backend.spell.calls).toHaveLength(2)
    expect(found.get('a')).toEqual([]) // the fake honours the sent dictionary
  })

  it('leaves out ignored findings, for the session only, per block', async () => {
    const first = await checkBlocks([{ id: 'a', text: 'teh' }, { id: 'b', text: 'teh' }])
    ignoreOnce('a', first.get('a')![0])
    const again = await checkBlocks([{ id: 'a', text: 'teh' }, { id: 'b', text: 'teh' }])
    expect(again.get('a')).toEqual([])
    expect(again.get('b')).toHaveLength(1)
    expect(backend.spell.calls).toHaveLength(1) // the cache keeps the raw findings
  })

  it('caches nothing when the engine fails', async () => {
    backend.spell.fail = true
    await expect(checkBlocks([{ id: 'a', text: 'teh' }])).rejects.toBeDefined()
    backend.spell.fail = false
    expect((await checkBlocks([{ id: 'a', text: 'teh' }])).get('a')).toHaveLength(1)
  })
})

describe('the finding cache', () => {
  it('hits on unchanged text, misses on other text and after a dictionary change', () => {
    const cache = createFindingCache()
    const f = [finding()]
    cache.set('teh', f)
    expect(cache.get('teh')).toBe(f)
    expect(cache.get('the')).toBeUndefined()
    addWord('Aelinor', 'user')
    expect(cache.get('teh')).toBeUndefined()
    removeWord('Aelinor', 'user')
    expect(cache.get('teh')).toBe(f) // same dictionary again, same key
  })

  it('is bounded and drops the least recently used entry first', () => {
    const cache = createFindingCache(2)
    cache.set('a', [])
    cache.set('b', [])
    cache.get('a')
    cache.set('c', [])
    expect(cache.size).toBe(2)
    expect(cache.get('a')).toBeDefined()
    expect(cache.get('b')).toBeUndefined()
  })
})

describe('the dictionary', () => {
  it('merges user and project words without duplicates, ignoring case', () => {
    expect(addWord('Aelinor', 'user')).toBe(true)
    expect(addWord('aelinor', 'user')).toBe(false)
    expect(addWord('AELINOR', 'project')).toBe(true) // another scope: its own list
    expect(addWord('Brynn', 'project')).toBe(true)
    expect(dictionaryWords()).toEqual(['Aelinor', 'Brynn'])
  })

  it('refuses a word that is empty, has spaces or is too long', () => {
    expect(addWord('  ', 'user')).toBe(false)
    expect(addWord('two words', 'user')).toBe(false)
    expect(addWord('x'.repeat(65), 'user')).toBe(false)
    expect(addWord('  Brynn  ', 'user')).toBe(true)
    expect(dictionaryWords()).toEqual(['Brynn'])
  })

  it('the dictionary version changes with the words, not with their order or case', () => {
    const empty = dictionaryVersion()
    addWord('Brynn', 'user')
    addWord('Aelinor', 'user')
    const v = dictionaryVersion()
    expect(v).not.toBe(empty)
    useStore.getState().preferencesActions.set('spellcheck', { enabled: true, words: ['aelinor', 'BRYNN'] })
    expect(dictionaryVersion()).toBe(v)
  })

  it('the user dictionary is a preference (spellcheck.words), saved with preferences.json', () => {
    addWord('Aelinor', 'user')
    expect(useStore.getState().preferences.spellcheck).toEqual({ enabled: true, words: ['Aelinor'] })
  })

  it('adding a word keeps the spell check on/off preference', () => {
    useStore.getState().preferencesActions.set('spellcheck', { enabled: false, words: [] })
    addWord('Aelinor', 'user')
    removeWord('Aelinor', 'user')
    expect(useStore.getState().preferences.spellcheck.enabled).toBe(false)
  })

  it('a full user dictionary does not push the project words out (each scope is capped on its own)', () => {
    const full = Array.from({ length: MAX_DICTIONARY_WORDS }, (_, i) => `user${i}`)
    useStore.getState().preferencesActions.set('spellcheck', { enabled: true, words: full })
    useStore.getState().spellcheckActions.loadProjectWords(['Aelinor', 'USER3'])
    const words = dictionaryWords()
    expect(words).toContain('Aelinor')
    expect(words).toHaveLength(MAX_DICTIONARY_WORDS + 1) // USER3 is user3 again
  })
})
