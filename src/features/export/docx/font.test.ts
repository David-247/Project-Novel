import { describe, expect, it } from 'vitest'
import { FONT_FALLBACKS } from '../settings/presets'
import { docxFontReport } from './font'
import { knownSingleLineEm, singleLineEm } from './layout'

const allFamilies = Object.values(FONT_FALLBACKS).flat()

describe('docxFontReport (as the PDF render report)', () => {
  it('the trimmed family; substituted when it is not a known manuscript family', () => {
    expect(docxFontReport({ fontFamily: '  Times New Roman ' })).toEqual({ requested: 'Times New Roman', substituted: false })
    expect(docxFontReport({ fontFamily: 'cousine' })).toEqual({ requested: 'cousine', substituted: false })
    expect(docxFontReport({ fontFamily: 'Garamond' })).toEqual({ requested: 'Garamond', substituted: true })
  })

  it('every FONT_FALLBACKS family is known (substituted: false)', () => {
    expect(allFamilies.length).toBeGreaterThanOrEqual(6)
    for (const f of allFamilies) expect(docxFontReport({ fontFamily: f }), f).toEqual({ requested: f, substituted: false })
  })
})

describe('single line metrics', () => {
  it('cover every FONT_FALLBACKS family, a stand-in with its face', () => {
    for (const [face, families] of Object.entries(FONT_FALLBACKS)) {
      for (const f of families) expect(knownSingleLineEm(f), f).toBe(knownSingleLineEm(face))
      expect(knownSingleLineEm(face), face).toBeDefined()
    }
    expect(singleLineEm(' times new roman ')).toBe(1.1499)
    expect(singleLineEm('Cousine')).toBe(1.1328)
    expect(singleLineEm('Garamond')).toBe(1.15)
  })
})
