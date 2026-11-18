/**
 * Typical novel lengths by genre, for the wizard's length check. Figures are agents' published rules of
 * thumb, not rules; each entry names its sources (URLs and access date in docs/manuscript-format.md,
 * "Word counts by genre"). The wizard warns, it never blocks.
 */
export interface WordRange {
  min: number
  max: number
}

export interface GenreWordCount {
  id: string
  label: string
  /** The usual range for the genre. */
  typical: WordRange
  /** The range agents suggest for a first novel, where a source gives one. */
  debut?: WordRange
  /** Ids of the sources in docs/manuscript-format.md. */
  sources: readonly string[]
}

/** Source ids used below (see docs/manuscript-format.md, "Sources"). */
export const GENRE_SOURCES = {
  bransford: { id: 'S-bransford', url: 'https://nathanbransford.com/?p=9760', accessed: '2026-11-18' },
  broad: { id: 'S-broad', url: 'https://katebroad.substack.com/p/more-on-word-count', accessed: '2026-11-18' },
} as const

const B = GENRE_SOURCES.bransford.id
const K = GENRE_SOURCES.broad.id

export const GENRE_WORD_COUNTS: readonly GenreWordCount[] = [
  { id: 'literary', label: 'Literary fiction', typical: { min: 50_000, max: 120_000 }, sources: [B] },
  { id: 'commercial', label: 'Commercial / general fiction', typical: { min: 75_000, max: 100_000 }, debut: { min: 70_000, max: 100_000 }, sources: [B, K] },
  { id: 'historical', label: 'Historical fiction', typical: { min: 80_000, max: 120_000 }, sources: [B] },
  { id: 'fantasy', label: 'Fantasy', typical: { min: 80_000, max: 120_000 }, debut: { min: 100_000, max: 120_000 }, sources: [B, K] },
  { id: 'science-fiction', label: 'Science fiction', typical: { min: 90_000, max: 120_000 }, debut: { min: 100_000, max: 120_000 }, sources: [B, K] },
  { id: 'romance', label: 'Romance', typical: { min: 50_000, max: 90_000 }, sources: [B] },
  { id: 'mystery', label: 'Mystery', typical: { min: 75_000, max: 90_000 }, sources: [B] },
  { id: 'thriller', label: 'Thriller', typical: { min: 80_000, max: 100_000 }, sources: [B] },
  { id: 'ya', label: 'Young adult', typical: { min: 60_000, max: 80_000 }, sources: [B] },
  { id: 'middle-grade', label: 'Middle grade', typical: { min: 30_000, max: 60_000 }, debut: { min: 30_000, max: 50_000 }, sources: [B, K] },
]

/** Above `typical.max` by this fraction a manuscript is "very long" (a debut of 130,000+ words is the sources' red line). */
export const VERY_LONG_FACTOR = 1.25

export type WordCountStatus = 'short' | 'within' | 'long' | 'very-long' | 'unknown'

export interface WordCountCheck {
  status: WordCountStatus
  /** The range the count was compared with (null when the genre is unknown). */
  range: WordRange | null
  genre: GenreWordCount | null
}

/** Compare a manuscript's word count with the range for its genre (the debut range when `debut` and one exists). */
export function checkWordCount(genreId: string, count: number, options: { debut?: boolean } = {}): WordCountCheck {
  const genre = GENRE_WORD_COUNTS.find((g) => g.id === genreId) ?? null
  if (!genre) return { status: 'unknown', range: null, genre: null }
  const range = options.debut && genre.debut ? genre.debut : genre.typical
  const status: WordCountStatus =
    count < range.min ? 'short' : count <= range.max ? 'within' : count <= genre.typical.max * VERY_LONG_FACTOR ? 'long' : 'very-long'
  return { status, range, genre }
}
