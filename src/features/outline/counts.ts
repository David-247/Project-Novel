import type { Node as PMNode } from '@tiptap/pm/model'
import { countRange } from '@/features/editor'
import type { RootState } from '@/shared/store'
import { addCounts } from '@/shared/text'
import type { Outline, OutlineEntry } from './model'

type WordCountState = RootState['wordCount']

/**
 * Words per outline entry (by key), counted as the status bar counts (the text with every tracked
 * change accepted; footnotes per "Include footnotes"). Chapters and Front matter take the store's
 * `wordCount` (published by the editor slice off the typing path) when it is for this document and the
 * ranges agree; otherwise (a markup view that hides or shows a chapter title, a count not yet published
 * for this version) and for subheadings the range is counted here, which reads only the blocks the
 * editor's per-block cache has not seen.
 */
export function countOutline(doc: PMNode, outline: Outline, wc: WordCountState, docVersion: number): Map<string, number> {
  const out = new Map<string, number>()
  const fresh = wc.ready && wc.docVersion === docVersion
  const words = (from: number, to: number) => {
    const c = countRange(doc, from, to)
    return (wc.includeFootnotes ? addCounts(c.body, c.footnotes) : c.body).words
  }
  const published = new Map<string, number>()
  if (fresh) for (const c of wc.chapters) published.set(`${c.from}:${c.to}`, c.counts.total.words)
  const firstChapterFrom = wc.chapters[0]?.from ?? doc.content.size
  const own = (e: OutlineEntry): number => {
    if (fresh && e.kind === 'chapter') {
      const n = published.get(`${e.from}:${e.to}`)
      if (n !== undefined) return n
    }
    if (fresh && e.kind === 'front' && e.from === 0 && e.to === firstChapterFrom) return wc.frontMatter.total.words
    return words(e.from, e.to)
  }
  for (const e of outline.entries) {
    out.set(e.key, own(e))
    for (const s of e.children) out.set(s.key, words(s.from, s.to))
  }
  return out
}
