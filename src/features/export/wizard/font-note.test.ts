import { describe, expect, it } from 'vitest'
import { formatFontNote, usedFontNote } from './font-note'

const WITH_TIMES = ['Arial', 'Times New Roman', 'Courier New', 'Garamond']
const NO_MS_FONTS = ['Arial', 'Garamond']

describe('formatFontNote: the Formatting step never claims a font the PDF does not use (B-I2, A-I2, D-M1)', () => {
  it('Times New Roman installed: the font of both files', () => {
    expect(formatFontNote('Times New Roman', WITH_TIMES)).toBe('The font the Word file names and the PDF is set in.')
    expect(formatFontNote('  courier new ', WITH_TIMES)).toBe('The font the Word file names and the PDF is set in.')
  })

  it('Times New Roman not installed: the PDF uses Liberation Serif', () => {
    expect(formatFontNote('Times New Roman', NO_MS_FONTS)).toMatch(/^Times New Roman is not installed on this computer\. The PDF uses Liberation Serif/)
  })

  it('an installed family the PDF cannot use (Garamond): the PDF is set in Times New Roman, Garamond is Word only', () => {
    const note = formatFontNote('Garamond', WITH_TIMES)
    expect(note).toBe('The PDF is set in Times New Roman: the PDF can use only Times New Roman or Courier New. Garamond applies to the Word file only.')
    expect(note).not.toMatch(/PDF is set in Garamond|names and the PDF/)
  })

  it('Garamond without Times New Roman: Liberation Serif, and says Garamond is not installed when it is not', () => {
    expect(formatFontNote('Garamond', ['Arial'])).toBe(
      'The PDF is set in Liberation Serif: the PDF can use only Times New Roman or Courier New. Garamond applies to the Word file only, and it is not installed on this computer.',
    )
  })

  it('Cousine is the mono role: Courier New, or Liberation Mono (never Liberation Serif)', () => {
    expect(formatFontNote('Cousine', ['Arial'])).toMatch(/^The PDF is set in Liberation Mono, which has the same letter widths as Cousine/)
    expect(formatFontNote('Cousine', WITH_TIMES)).toMatch(/^The PDF is set in Courier New, which has the same letter widths as Cousine/)
    expect(formatFontNote('Cousine', ['Arial'])).not.toMatch(/Serif/)
  })

  it('the installed fonts not known yet: names the font and its bundled stand-in', () => {
    expect(formatFontNote('Garamond', null)).toMatch(/^The PDF is set in Times New Roman \(or Liberation Serif where Times New Roman is not installed\)/)
    expect(formatFontNote('Times New Roman', [])).toBe('The font the Word file names and the PDF is set in.')
  })
})

describe('usedFontNote: the success screen names the font the PDF was set in when it is not the one asked for', () => {
  it('none when the PDF used the installed font the settings name', () => {
    expect(usedFontNote({ requested: 'Times New Roman', family: 'Times New Roman', source: 'system', substituted: false })).toBeNull()
    expect(usedFontNote(undefined)).toBeNull()
  })

  it('a substituted family', () => {
    expect(usedFontNote({ requested: 'Garamond', family: 'Times New Roman', source: 'system', substituted: true })).toBe(
      'The PDF is set in Times New Roman, not Garamond: the PDF can use only Times New Roman or Courier New. The Word file names Garamond.',
    )
  })

  it('the bundled fallback', () => {
    expect(usedFontNote({ requested: 'Times New Roman', family: 'Liberation Serif', source: 'bundled', substituted: false })).toBe(
      'The PDF is set in Liberation Serif, a free font bundled with Novel with the same letter widths as Times New Roman, which is not installed.',
    )
    expect(usedFontNote({ requested: 'Garamond', family: 'Liberation Serif', source: 'bundled', substituted: true })).toMatch(/Liberation Serif instead of Garamond/)
    expect(usedFontNote({ requested: 'Cousine', family: 'Liberation Mono', source: 'bundled', substituted: false })).toMatch(/as Courier New, which is not installed/)
  })

  it('a metric-identical stand-in set in the installed role font', () => {
    expect(usedFontNote({ requested: 'Tinos', family: 'Times New Roman', source: 'system', substituted: false })).toBe('The PDF is set in Times New Roman, which has the same letter widths as Tinos.')
  })
})
