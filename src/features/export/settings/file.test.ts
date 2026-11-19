import { describe, expect, it } from 'vitest'
import { defaultManuscriptSettings, EXPORT_FILE, EXPORT_FILE_VERSION, parseExportFile, serializeExportFile } from './index'

const D = () => defaultManuscriptSettings('en-US')

describe('parseExportFile', () => {
  it('null (no file) is the defaults for the locale', () => {
    const p = parseExportFile(null, 'en-GB')
    expect(p.settings).toEqual(defaultManuscriptSettings('en-GB'))
    expect(p.contact).toEqual({})
    expect(p.newer).toBeUndefined()
  })
  it('round-trips every setting', () => {
    const s = {
      ...D(),
      preset: 'classic' as const,
      paper: 'a4' as const,
      fontFamily: 'Courier New',
      lineSpacing: 1.5 as const,
      margins: { top: 1.18, right: 1.18, bottom: 1.18, left: 1.18 },
      header: { format: 'surname-title-page' as const, titleCase: 'upper' as const, startPage: 2 as const, shortTitle: 'SILVERTIDE' },
      sceneBreak: '* * *',
      endMarker: 'end' as const,
      chapterDropFraction: 0.5,
      titlePage: { ...D().titlePage, showAgent: true, bylineStyle: 'by' as const },
      wordCountRounding: 'nearest-1000' as const,
      outputs: { docx: false, pdf: true },
      checks: { genre: 'fantasy', debut: true, normalizeSpaces: true, blankLineSceneBreaks: 'off' as const },
    }
    const text = JSON.stringify(serializeExportFile({ settings: s, contact: { email: 'x@y.z' }, extra: {} }))
    const back = parseExportFile(JSON.parse(text), 'en-US')
    expect(back.settings).toEqual(s)
    expect(back.contact).toEqual({ email: 'x@y.z' })
  })
  it('a wrongly typed or out-of-range value falls back to its default, the rest is kept', () => {
    const p = parseExportFile(
      { version: 1, settings: { fontSizePt: 'big', paper: 'a3', lineSpacing: 7, sceneBreak: 5, margins: { top: -2, left: 1.5 }, chapterDropFraction: 3, preset: 'classic' } },
      'en-US',
    )
    expect(p.settings).toMatchObject({
      fontSizePt: 12,
      paper: 'letter',
      lineSpacing: 2,
      sceneBreak: '#',
      margins: { top: 1, left: 1.5, right: 1, bottom: 1 },
      chapterDropFraction: 1 / 3,
      preset: 'classic',
    })
  })
  it('checks: a bad value falls back field by field; an unknown genre id is kept, a malformed one is not', () => {
    const p = parseExportFile({ settings: { checks: { genre: 'space-opera', debut: 'yes', blankLineSceneBreaks: 'never' } } }, 'en-US')
    expect(p.settings.checks).toEqual({ genre: 'space-opera', debut: false, normalizeSpaces: false, blankLineSceneBreaks: 'auto' })
    expect(parseExportFile({ settings: { checks: { genre: '<script>' } } }, 'en-US').settings.checks.genre).toBe('')
    expect(parseExportFile({ settings: { checks: 3 } }, 'en-US').settings.checks).toEqual(D().checks)
  })
  it('chapterDropFraction is 0 to 0.5 everywhere: 0.5 is kept, more falls back to one third', () => {
    expect(parseExportFile({ settings: { chapterDropFraction: 0.5 } }, 'en-US').settings.chapterDropFraction).toBe(0.5)
    expect(parseExportFile({ settings: { chapterDropFraction: 0.6 } }, 'en-US').settings.chapterDropFraction).toBe(1 / 3)
  })
  it('lastOutputFolder from an older file is dropped, not kept and not written', () => {
    const p = parseExportFile({ version: 1, settings: { lastOutputFolder: 'C:\\Users\\ada\\Out', keep: 1 } }, 'en-US')
    expect('lastOutputFolder' in p.settings).toBe(false)
    expect(JSON.stringify(serializeExportFile(p))).not.toMatch(/ada|lastOutputFolder/)
    expect(p.settingsExtra).toEqual({ keep: 1 })
  })
  it('does not trim text fields (a space just typed must stay)', () => {
    expect(parseExportFile({ settings: { sceneBreak: '* ', header: { shortTitle: 'The ' } } }, 'en-US').settings).toMatchObject({ sceneBreak: '* ', header: { shortTitle: 'The ' } })
  })
  it('an unknown paper in a file with no paper uses the locale', () => {
    expect(parseExportFile({ version: 1, settings: {} }, 'en-GB').settings.paper).toBe('a4')
  })
  it('keeps unknown keys (top level and in settings) and writes them back', () => {
    const p = parseExportFile({ version: 1, future: { a: 1 }, settings: { futureOption: true } }, 'en-US')
    const out = serializeExportFile(p) as { future: unknown; settings: { futureOption: boolean }; version: number }
    expect(out.future).toEqual({ a: 1 })
    expect(out.settings.futureOption).toBe(true)
    expect(out.version).toBe(EXPORT_FILE_VERSION)
  })
  it('reports a newer file but still reads what it understands', () => {
    const p = parseExportFile({ version: EXPORT_FILE_VERSION + 1, settings: { fontSizePt: 14 } }, 'en-US')
    expect(p.newer).toBe(EXPORT_FILE_VERSION + 1)
    expect(p.settings.fontSizePt).toBe(14)
  })
  it('contact: only non-empty strings, trimmed, length-limited', () => {
    const p = parseExportFile({ version: 1, contact: { legalName: '  Ada ', email: '', phone: 5, address: 'x'.repeat(2000) } }, 'en-US')
    expect(p.contact.legalName).toBe('Ada')
    expect('email' in p.contact).toBe(false)
    expect('phone' in p.contact).toBe(false)
    expect(p.contact.address!.length).toBeLessThanOrEqual(400)
  })
})

describe('serializeExportFile', () => {
  it('writes no contact details unless there is an override', () => {
    const out = serializeExportFile({ settings: D(), contact: {}, extra: {} }) as Record<string, unknown>
    expect('contact' in out).toBe(false)
    expect(JSON.stringify(out)).not.toMatch(/Lovelace/)
  })
  it('writes only the override fields', () => {
    const out = serializeExportFile({ settings: D(), contact: { phone: '555' }, extra: {} }) as { contact: unknown }
    expect(out.contact).toEqual({ phone: '555' })
  })
  it('names the file export.json', () => expect(EXPORT_FILE).toBe('export.json'))
})
