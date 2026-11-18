import { addCounts, sameCounts, ZERO_COUNTS, type TextCounts } from '@/shared/text'
import type { SliceCreator } from './types'

/**
 * Live word counts of the manuscript (Phase 4; docs/word-count.md), published by the editor slice off
 * the typing path (at most every ~150 ms, in an idle callback) and read by the status bar, the Word
 * Count dialog, the navigation pane and the export wizard.
 *
 * Every count is of the text as it reads with every pending tracked change accepted (what export
 * produces), whatever the markup view; comments and re-write versions are never counted. Each entry
 * keeps the body text and the footnotes apart (`body`, `footnotes`) and gives `total`: body plus
 * footnotes while `includeFootnotes` is on (Word's "Include footnotes", default on), else the body.
 * Pages and lines are not here: pages are `layout`'s, lines the pagination slice's `countLines`.
 */
export interface CountsWithNotes {
  body: TextCounts
  footnotes: TextCounts
  /** `body + footnotes` when `includeFootnotes`, else `body`. */
  total: TextCounts
}

export interface ChapterWordCounts {
  /** 0-based, as `getChapters` (editor slice) numbers chapters. */
  index: number
  title: string
  /** The chapter's document range `[from, to)` (top-level block boundaries). */
  from: number
  to: number
  counts: CountsWithNotes
}

/** What the editor slice publishes (raw counts; `total` is derived here). */
export interface WordCountPublish {
  document: { body: TextCounts; footnotes: TextCounts }
  /** Null when the selection is empty (a caret). */
  selection: { body: TextCounts; footnotes: TextCounts; from: number; to: number } | null
  /** Content before the first chapter. */
  frontMatter: { body: TextCounts; footnotes: TextCounts }
  chapters: { index: number; title: string; from: number; to: number; body: TextCounts; footnotes: TextCounts }[]
  /** `editor.docVersion` of the counted document. */
  docVersion: number
}

export interface WordCountSlice {
  wordCount: {
    /** False until the mounted manuscript has been counted once (and after `reset`). */
    ready: boolean
    /** Word's "Include footnotes" (Word Count dialog). Applies to every `total`. UI state, not saved. */
    includeFootnotes: boolean
    document: CountsWithNotes
    /** The selection's counts and range; null with a caret. */
    selection: (CountsWithNotes & { from: number; to: number }) | null
    frontMatter: CountsWithNotes
    /** Per chapter, in order (empty when the book has no chapter title). */
    chapters: ChapterWordCounts[]
    /** `editor.docVersion` the counts are for (-1 before the first count). */
    docVersion: number
  }
  wordCountActions: {
    publish: (counts: WordCountPublish) => void
    setIncludeFootnotes: (on: boolean) => void
    /** No manuscript mounted. */
    reset: () => void
  }
}

const withNotes = (body: TextCounts, footnotes: TextCounts, include: boolean): CountsWithNotes => ({
  body,
  footnotes,
  total: include ? addCounts(body, footnotes) : body,
})

const zeroNotes = (): CountsWithNotes => withNotes({ ...ZERO_COUNTS }, { ...ZERO_COUNTS }, true)

const sameNotes = (a: CountsWithNotes | null, b: { body: TextCounts; footnotes: TextCounts } | null) =>
  !a || !b ? a === b : sameCounts(a.body, b.body) && sameCounts(a.footnotes, b.footnotes)

const initial = (includeFootnotes = true): WordCountSlice['wordCount'] => ({
  ready: false,
  includeFootnotes,
  document: zeroNotes(),
  selection: null,
  frontMatter: zeroNotes(),
  chapters: [],
  docVersion: -1,
})

export const createWordCountSlice: SliceCreator<WordCountSlice> = (set) => ({
  wordCount: initial(),
  wordCountActions: {
    publish: (p) =>
      set((s) => {
        const w = s.wordCount
        const inc = w.includeFootnotes
        // Keep unchanged parts (and the whole state when nothing changed): no re-render per publish.
        const document = sameNotes(w.document, p.document) ? w.document : withNotes(p.document.body, p.document.footnotes, inc)
        const selection =
          p.selection && w.selection && w.selection.from === p.selection.from && w.selection.to === p.selection.to && sameNotes(w.selection, p.selection)
            ? w.selection
            : p.selection
              ? { ...withNotes(p.selection.body, p.selection.footnotes, inc), from: p.selection.from, to: p.selection.to }
              : null
        const frontMatter = sameNotes(w.frontMatter, p.frontMatter) ? w.frontMatter : withNotes(p.frontMatter.body, p.frontMatter.footnotes, inc)
        const sameChapters =
          w.chapters.length === p.chapters.length &&
          p.chapters.every((c, i) => {
            const o = w.chapters[i]
            return o.index === c.index && o.title === c.title && o.from === c.from && o.to === c.to && sameNotes(o.counts, c)
          })
        const chapters = sameChapters
          ? w.chapters
          : p.chapters.map((c) => ({ index: c.index, title: c.title, from: c.from, to: c.to, counts: withNotes(c.body, c.footnotes, inc) }))
        if (w.ready && document === w.document && selection === w.selection && frontMatter === w.frontMatter && chapters === w.chapters && w.docVersion === p.docVersion) return s
        return { wordCount: { ...w, ready: true, document, selection, frontMatter, chapters, docVersion: p.docVersion } }
      }),
    setIncludeFootnotes: (on) =>
      set((s) => {
        const w = s.wordCount
        if (w.includeFootnotes === on) return s
        const re = (c: CountsWithNotes) => withNotes(c.body, c.footnotes, on)
        return {
          wordCount: {
            ...w,
            includeFootnotes: on,
            document: re(w.document),
            selection: w.selection ? { ...re(w.selection), from: w.selection.from, to: w.selection.to } : null,
            frontMatter: re(w.frontMatter),
            chapters: w.chapters.map((c) => ({ ...c, counts: re(c.counts) })),
          },
        }
      }),
    reset: () => set((s) => ({ wordCount: initial(s.wordCount.includeFootnotes) })),
  },
})
