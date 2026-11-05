import { beforeEach, describe, expect, it } from 'vitest'
import { newProjectBookSettings } from '@/shared/book'
import { defaultPreferenceValues, parsePreferences, PREFERENCES_VERSION, serializePreferences } from './preferences-file'
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
    }
    const parsed = parsePreferences(serializePreferences({ ...values, extra: {} }))
    expect(parsed).toMatchObject({ values, extra: {}, authorNameMissing: false, fallback: null })
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
