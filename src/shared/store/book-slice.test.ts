import { beforeEach, describe, expect, it } from 'vitest'
import { defaultBookSettings, defaultHeaderFooter } from '@/shared/book'
import { useStore } from './index'

const book = () => useStore.getState().book
const a = () => useStore.getState().bookActions

beforeEach(() => a().resetBook())

describe('book slice', () => {
  it('starts with defaults and clean', () => {
    expect(book()).toMatchObject({ ...defaultBookSettings(), dirty: false })
  })

  it.each([
    ['setTrimSize', () => a().setTrimSize('uk-a5'), { trimSize: 'uk-a5' }],
    ['setMargins', () => a().setMargins({ top: 1, bottom: 2, inside: 3, outside: 4 }), { margins: { top: 1, bottom: 2, inside: 3, outside: 4 } }],
    ['setStyles (value)', () => a().setStyles({ body: { size: 11 } }), { styles: { body: { size: 11 } } }],
    ['setHeaderFooter (updater)', () => a().setHeaderFooter((p) => ({ ...p, suppressOnBlank: false })), { headerFooter: { ...defaultHeaderFooter(), suppressOnBlank: false } }],
    ['setFootnotes (updater)', () => a().setFootnotes((p) => ({ ...p, y: 2 })), { footnotes: { y: 2 } }],
    ['setSurface', () => a().setSurface('dark'), { surface: 'dark' }],
    ['setView', () => a().setView('single'), { view: 'single' }],
  ])('%s updates state, bumps the version and marks the project unsaved', (_name, run, expected) => {
    const before = book().settingsVersion
    run()
    expect(book()).toMatchObject({ ...expected, dirty: true })
    expect(book().settingsVersion).toBe(before + 1)
  })

  it('markBookClean clears dirty only if nothing changed since the saved version (race-safe)', () => {
    a().setSurface('white')
    const saved = book().settingsVersion
    a().setView('single') // change during the async save
    a().markBookClean(saved)
    expect(book().dirty).toBe(true)
    a().markBookClean(book().settingsVersion)
    expect(book().dirty).toBe(false)
  })

  it('loadBook and resetBook replace settings without marking unsaved; restoreBook marks unsaved', () => {
    a().setSurface('white')
    a().loadBook({ ...defaultBookSettings(), trimSize: 'uk-demy' })
    expect(book()).toMatchObject({ trimSize: 'uk-demy', surface: 'auto', dirty: false })
    a().restoreBook({ ...defaultBookSettings(), trimSize: 'us-6x9' })
    expect(book()).toMatchObject({ trimSize: 'us-6x9', dirty: true })
    a().resetBook()
    expect(book()).toMatchObject({ ...defaultBookSettings(), dirty: false })
  })
})
