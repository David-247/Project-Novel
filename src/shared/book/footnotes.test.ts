import { describe, expect, it } from 'vitest'
import {
  DEFAULT_FOOTNOTE_OPTIONS,
  FOOTNOTE_TEXT_STYLE_ID,
  footnoteLabel,
  resolveFootnoteOptions,
  resolveStyleSheet,
  writeFootnoteOptions,
} from './index'
import type { FootnoteSettings } from './index'

describe('footnote settings (book.footnotes)', () => {
  it('defaults: per book, arabic, separator on', () => {
    expect(resolveFootnoteOptions({})).toEqual({ numbering: 'book', format: 'arabic', separator: true })
    expect(DEFAULT_FOOTNOTE_OPTIONS).toEqual({ numbering: 'book', format: 'arabic', separator: true })
  })

  it('reads valid fields and ignores invalid ones', () => {
    expect(resolveFootnoteOptions({ numbering: 'chapter', format: 'symbols', separator: false })).toEqual({
      numbering: 'chapter',
      format: 'symbols',
      separator: false,
    })
    expect(resolveFootnoteOptions({ numbering: 'page', format: 'roman', separator: 'yes' } as unknown as FootnoteSettings)).toEqual(DEFAULT_FOOTNOTE_OPTIONS)
  })

  it('writes the options and keeps unknown keys', () => {
    expect(writeFootnoteOptions({ future: 1 }, { numbering: 'chapter' })).toEqual({ future: 1, numbering: 'chapter' })
    expect(writeFootnoteOptions({ numbering: 'chapter' }, { format: 'symbols', separator: false })).toEqual({
      numbering: 'chapter',
      format: 'symbols',
      separator: false,
    })
  })
})

describe('footnoteLabel', () => {
  it('arabic', () => {
    expect([1, 2, 10, 123].map((n) => footnoteLabel(n, 'arabic'))).toEqual(['1', '2', '10', '123'])
  })

  it('symbols: *, †, ‡, §, ‖, ¶, then doubled, tripled', () => {
    expect([1, 2, 3, 4, 5, 6].map((n) => footnoteLabel(n, 'symbols'))).toEqual(['*', '†', '‡', '§', '‖', '¶'])
    expect(footnoteLabel(7, 'symbols')).toBe('**')
    expect(footnoteLabel(8, 'symbols')).toBe('††')
    expect(footnoteLabel(13, 'symbols')).toBe('***')
  })
})

describe('Footnote Text built-in style', () => {
  it('is registered: smaller than Body, no indent', () => {
    const s = resolveStyleSheet({}).get(FOOTNOTE_TEXT_STYLE_ID)!
    expect(s.name).toBe('Footnote Text')
    expect(s.builtIn).toBe(true)
    expect(s.fontSize).toBeLessThan(resolveStyleSheet({}).get('body')!.fontSize!)
    expect(s.firstLineIndent).toBe(0)
  })
})
