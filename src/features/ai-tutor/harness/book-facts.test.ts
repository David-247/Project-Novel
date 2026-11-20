import { describe, expect, it } from 'vitest'
import { formatBookFacts } from './book-facts'

describe('formatBookFacts', () => {
  it('lists title, genre, word count, chapters, trim size and manuscript preset', () => {
    const text = formatBookFacts({
      title: 'The Long Road',
      genre: 'Literary fiction',
      words: 84213,
      chapters: [
        { number: 1, title: 'Departure', words: 4100 },
        { number: 2, title: '', words: 3900 },
      ],
      trimSize: '5.5 x 8.5 in',
      preset: 'Standard (modern)',
    })
    expect(text).toBe(
      [
        '# Book facts',
        '',
        '- Title: The Long Road',
        '- Genre: Literary fiction',
        '- Word count: 84,213',
        '- Trim size: 5.5 x 8.5 in',
        '- Manuscript preset: Standard (modern)',
        '- Chapters (2):',
        '  - Chapter 1: Departure (4,100 words)',
        '  - Chapter 2: Untitled chapter 2 (3,900 words)',
      ].join('\n'),
    )
  })

  it('says plainly what is not set', () => {
    const text = formatBookFacts({ title: null, genre: null, words: 0, chapters: [], trimSize: '6 x 9 in', preset: 'Classic (Courier)' })
    expect(text).toContain('- Title: (untitled)')
    expect(text).toContain('- Genre: (not set)')
    expect(text).toContain('- Chapters: none yet (no chapter titles)')
  })

  it('keeps a title from breaking the list', () => {
    expect(formatBookFacts({ title: 'A\nB', genre: null, words: 1, chapters: [], trimSize: 'x', preset: 'y' })).toContain('- Title: A B')
  })
})
