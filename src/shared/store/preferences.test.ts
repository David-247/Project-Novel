import { beforeEach, describe, expect, it } from 'vitest'
import { newProjectBookSettings } from '@/shared/book'
import { defaultPreferenceValues, MAX_DICTIONARY_WORDS, readDictionaryWords, NAV_PANE_DEFAULT_WIDTH, NAV_PANE_MAX_WIDTH, NAV_PANE_MIN_WIDTH, parsePreferences, PREFERENCES_VERSION, serializePreferences } from './preferences-file'
import { setSystemAuthorName } from './preferences-slice'
import { useStore } from './index'

const prefs = () => useStore.getState().preferences
const a = () => useStore.getState().preferencesActions

beforeEach(() => {
  setSystemAuthorName('')
  a().reset()
  useStore.setState((s) => ({ preferences: { ...s.preferences, loaded: false, extra: {}, authorPrompted: false } }))
})

describe('preferences slice', () => {
  it('starts with the defaults, not loaded', () => {
    expect(prefs()).toEqual({ ...defaultPreferenceValues(), extra: {}, loaded: false })
    expect(prefs().pageNavigation).toBe('book')
  })

  it('object-valued defaults are shared objects, so a fresh default never looks like a change', () => {
    const one = defaultPreferenceValues()
    const two = defaultPreferenceValues()
    for (const k of Object.keys(one) as (keyof typeof one)[]) {
      if (typeof one[k] === 'object' && one[k] !== null) expect(two[k], k).toBe(one[k])
    }
    expect(Object.isFrozen(one.spellcheck)).toBe(true)
  })

  it('set changes one key', () => {
    a().set('pageNavigation', 'scroll')
    a().set('authorName', 'Ada')
    expect(prefs()).toMatchObject({ pageNavigation: 'scroll', authorName: 'Ada', reduceMotion: 'system' })
  })

  it('load replaces the values, keeps unknown keys and marks the slice loaded', () => {
    a().load({ authorName: 'Grace', defaultPaper: 'dark', extra: { future: 1 } })
    expect(prefs()).toMatchObject({ authorName: 'Grace', defaultPaper: 'dark', pageNavigation: 'book', loaded: true, extra: { future: 1 } })
  })

  it('reset restores the defaults with the OS author name, keeping unknown keys and the loaded flag', () => {
    setSystemAuthorName('Account Name')
    a().load({ authorName: 'Someone', pageNavigation: 'scroll', authorPrompted: true, extra: { future: true } })
    a().reset()
    expect(prefs()).toMatchObject({
      authorName: 'Account Name',
      pageNavigation: 'book',
      authorPrompted: true,
      extra: { future: true },
      loaded: true,
    })
  })
})

describe('preferences.json', () => {
  it('round-trips every key', () => {
    const values = {
      authorName: 'Ada Lovelace',
      authorColor: '#aa3366',
      pageNavigation: 'scroll' as const,
      defaultPaper: 'white' as const,
      defaultTrimSize: 'us-6x9',
      reduceMotion: 'on' as const,
      authorPrompted: true,
      profileLegalName: 'Augusta Ada King',
      profilePenName: 'Ada Lovelace',
      profileAddress: '1 Analytical Way\nLondon',
      profilePhone: '+44 20 7946 0000',
      profileEmail: 'ada@example.com',
      profileAgent: 'Babbage & Co.',
      exportFolders: { 'project-id': '/exports' },
      navigationPane: true,
      navigationPaneWidth: 320,
      tutorActiveConnection: 'conn-1',
      tutorPlanWarningSeen: true,
      spellcheck: { enabled: false, words: ['Aelinor', 'Zoë'] },
    }
    const parsed = parsePreferences(serializePreferences({ ...values, extra: {} }))
    expect(parsed).toMatchObject({ values, extra: {}, authorNameMissing: false, fallback: null })
  })

  it('the navigation pane: open state and width, the width kept in range, wrong types fall back', () => {
    expect(defaultPreferenceValues()).toMatchObject({ navigationPane: false, navigationPaneWidth: NAV_PANE_DEFAULT_WIDTH })
    const read = (o: Record<string, unknown>) => parsePreferences(JSON.stringify({ version: 1, ...o })).values
    expect(read({ navigationPane: true, navigationPaneWidth: 333.4 })).toMatchObject({ navigationPane: true, navigationPaneWidth: 333 })
    expect(read({ navigationPaneWidth: 10 }).navigationPaneWidth).toBe(NAV_PANE_MIN_WIDTH)
    expect(read({ navigationPaneWidth: 5000 }).navigationPaneWidth).toBe(NAV_PANE_MAX_WIDTH)
    expect(read({ navigationPane: 'yes', navigationPaneWidth: 'wide' })).toMatchObject({ navigationPane: false, navigationPaneWidth: NAV_PANE_DEFAULT_WIDTH })
  })

  it('the tutor active connection: null or a short id, anything else falls back to none', () => {
    const read = (o: Record<string, unknown>) => parsePreferences(JSON.stringify({ version: 1, ...o })).values.tutorActiveConnection
    expect(defaultPreferenceValues().tutorActiveConnection).toBeNull()
    expect(read({ tutorActiveConnection: 'c1' })).toBe('c1')
    expect(read({ tutorActiveConnection: '' })).toBeNull()
    expect(read({ tutorActiveConnection: 7 })).toBeNull()
    expect(read({ tutorActiveConnection: 'x'.repeat(129) })).toBeNull()
    const seen = (o: Record<string, unknown>) => parsePreferences(JSON.stringify({ version: 1, ...o })).values.tutorPlanWarningSeen
    expect(defaultPreferenceValues().tutorPlanWarningSeen).toBe(false)
    expect(seen({ tutorPlanWarningSeen: true })).toBe(true)
    expect(seen({ tutorPlanWarningSeen: 'yes' })).toBe(false)
  })

  it('writes the version first-class and trims the name', () => {
    const json = JSON.parse(serializePreferences({ ...defaultPreferenceValues('  Ada  '), extra: {} }))
    expect(json).toMatchObject({ version: PREFERENCES_VERSION, authorName: 'Ada' })
  })

  it('keeps unknown keys through a read and write, and ours win a clash', () => {
    const text = JSON.stringify({ version: 1, authorName: 'Ada', futureThing: { a: [1, 2] }, other: 'x' })
    const parsed = parsePreferences(text)
    expect(parsed.extra).toEqual({ futureThing: { a: [1, 2] }, other: 'x' })
    const again = JSON.parse(serializePreferences({ ...parsed.values, authorName: 'Bea', extra: { ...parsed.extra, authorName: 'bad' } }))
    expect(again).toMatchObject({ futureThing: { a: [1, 2] }, other: 'x', authorName: 'Bea', version: 1 })
  })

  it.each([
    ['a missing file', null, 'absent'],
    ['damaged JSON', '{ "authorName": "Ad', 'damaged'],
    ['empty text', '', 'damaged'],
    ['a JSON array', '[1,2]', 'damaged'],
    ['a JSON string', '"hi"', 'damaged'],
    ['JSON null', 'null', 'damaged'],
  ])('%s falls back to the defaults without throwing', (_name, text, fallback) => {
    const parsed = parsePreferences(text)
    expect(parsed.values).toEqual(defaultPreferenceValues())
    expect(parsed.fallback).toBe(fallback)
    expect(parsed.authorNameMissing).toBe(true)
    expect(parsed.extra).toEqual({})
  })

  it('falls back per key: a wrongly typed value does not spoil the others', () => {
    const parsed = parsePreferences(
      JSON.stringify({
        version: 1,
        authorName: 7,
        authorColor: 'red',
        pageNavigation: 'flip',
        defaultPaper: 'white',
        defaultTrimSize: 'not-a-size',
        reduceMotion: true,
      }),
    )
    expect(parsed.values).toEqual({ ...defaultPreferenceValues(), defaultPaper: 'white' })
    expect(parsed.authorNameMissing).toBe(true)
    expect(parsed.fallback).toBeNull()
  })

  it('a stored empty author name is a name, not a missing one', () => {
    expect(parsePreferences(JSON.stringify({ version: 1, authorName: '' })).authorNameMissing).toBe(false)
  })

  it('migrates a file without a version (the v1 keys) and reads a newer file it partly understands', () => {
    expect(parsePreferences(JSON.stringify({ authorName: 'Old' })).values.authorName).toBe('Old')
    const newer = parsePreferences(JSON.stringify({ version: 99, authorName: 'New', pageNavigation: 'scroll', shiny: 1 }))
    expect(newer.values).toMatchObject({ authorName: 'New', pageNavigation: 'scroll' })
    expect(newer.extra).toEqual({ shiny: 1 })
  })

  it('accepts only #rrggbb author colours (normalised to lower case) or null', () => {
    expect(parsePreferences('{"authorColor":"#AABBCC"}').values.authorColor).toBe('#aabbcc')
    expect(parsePreferences('{"authorColor":null}').values.authorColor).toBeNull()
    expect(parsePreferences('{"authorColor":"#abc"}').values.authorColor).toBeNull()
  })

  it('caps the author name length', () => {
    expect(parsePreferences(JSON.stringify({ authorName: 'x'.repeat(500) })).values.authorName).toHaveLength(120)
  })

  it('author profile: empty by default, trimmed on write, wrongly typed values default, long ones are capped', () => {
    expect(defaultPreferenceValues()).toMatchObject({ profileLegalName: '', profilePenName: '', profileAddress: '', profilePhone: '', profileEmail: '', profileAgent: '' })
    const json = JSON.parse(serializePreferences({ ...defaultPreferenceValues(), profileEmail: '  a@b.c ', extra: {} }))
    expect(json.profileEmail).toBe('a@b.c')
    const parsed = parsePreferences(JSON.stringify({ version: 1, profilePhone: 5, profileAddress: 'x'.repeat(900) }))
    expect(parsed.values.profilePhone).toBe('')
    expect(parsed.values.profileAddress).toHaveLength(400)
  })

  it('exportFolders: per-project folders, read defensively, capped, and the default is a stable shared object', () => {
    expect(defaultPreferenceValues().exportFolders).toBe(defaultPreferenceValues().exportFolders)
    const parsed = parsePreferences(JSON.stringify({ version: 1, exportFolders: { p1: '/out', p2: 5, p3: '', p4: ['x'] } }))
    expect(parsed.values.exportFolders).toEqual({ p1: '/out' })
    expect(parsePreferences(JSON.stringify({ exportFolders: [1] })).values.exportFolders).toEqual({})
    const many = Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`p${i}`, `/o${i}`]))
    expect(Object.keys(parsePreferences(JSON.stringify({ exportFolders: many })).values.exportFolders)).toHaveLength(50)
    expect(JSON.parse(serializePreferences({ ...defaultPreferenceValues(), exportFolders: { a: '/x' }, extra: {} })).exportFolders).toEqual({ a: '/x' })
  })

  it('Reset to defaults keeps the author profile (it is typed data, not a preference)', () => {
    a().set('profileLegalName', 'Ada King')
    a().set('pageNavigation', 'scroll')
    a().reset()
    expect(prefs()).toMatchObject({ profileLegalName: 'Ada King', pageNavigation: 'book' })
  })
})

describe('newProjectBookSettings', () => {
  it('applies the paper and the trim size with its margins', () => {
    const b = newProjectBookSettings({ defaultPaper: 'dark', defaultTrimSize: 'us-6x9' })
    expect(b).toMatchObject({ surface: 'dark', trimSize: 'us-6x9', margins: { top: 58, bottom: 58, inside: 68, outside: 50 } })
  })

  it('falls back to the default trim size for an unknown id', () => {
    expect(newProjectBookSettings({ defaultPaper: 'auto', defaultTrimSize: 'gone' })).toMatchObject({ trimSize: 'us-5.5x8.5' })
  })
})

describe('the user dictionary preference', () => {
  const read = (o: Record<string, unknown>) => parsePreferences(JSON.stringify({ version: 1, ...o })).values.spellcheck
  it('defaults to no words and keeps clean, distinct, single words only', () => {
    expect(defaultPreferenceValues().spellcheck).toEqual({ enabled: true, words: [] })
    expect(read({ spellcheck: { words: ['Aelinor', 'aelinor', ' Brynn ', 'two words', 7, '', 'x'.repeat(65)] } })).toEqual({ enabled: true, words: ['Aelinor', 'Brynn'] })
  })
  it('wrong types fall back to the default', () => {
    expect(read({ spellcheck: 'x' })).toEqual({ enabled: true, words: [] })
    expect(read({ spellcheck: { words: 'Aelinor', enabled: 'no' } })).toEqual({ enabled: true, words: [] })
  })
  it('View > Spelling & Grammar (spellcheck.enabled) is on by default, and an off is kept', () => {
    expect(read({})).toEqual({ enabled: true, words: [] })
    expect(read({ spellcheck: { enabled: false, words: ['Aelinor'] } })).toEqual({ enabled: false, words: ['Aelinor'] })
    const values = { ...defaultPreferenceValues(), spellcheck: { enabled: false, words: ['Zoë'] } }
    expect(JSON.parse(serializePreferences({ ...values, extra: {} })).spellcheck).toEqual({ enabled: false, words: ['Zoë'] })
  })
  it('readDictionaryWords caps a list at MAX_DICTIONARY_WORDS unless told another limit', () => {
    const many = Array.from({ length: MAX_DICTIONARY_WORDS + 10 }, (_, i) => `w${i}`)
    expect(readDictionaryWords(many)).toHaveLength(MAX_DICTIONARY_WORDS)
    expect(readDictionaryWords(many, Infinity)).toHaveLength(MAX_DICTIONARY_WORDS + 10)
  })
})
