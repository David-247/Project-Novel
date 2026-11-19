import { describe, expect, it } from 'vitest'
import { xmlSafe } from './text'

describe('xmlSafe', () => {
  it('drops what XML 1.0 cannot hold and keeps tab, line feeds and emoji', () => {
    expect(xmlSafe('a\u0000b\u0001c\u0008d\u000Be\u000Cf\u001Fg￾h￿i')).toBe('abcdefghi')
    expect(xmlSafe('tab\tlf\ncr\r')).toBe('tab\tlf\ncr\r')
    expect(xmlSafe('😀 👩‍👩‍👧 é')).toBe('😀 👩‍👩‍👧 é')
    expect(xmlSafe('lone \uD800 high, lone \uDC00 low')).toBe('lone  high, lone  low')
    expect(xmlSafe('& < > " \'')).toBe('& < > " \'') // escaping is the docx library's job
  })
})
