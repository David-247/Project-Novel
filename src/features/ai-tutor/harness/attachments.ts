import type { Node as PMNode } from '@tiptap/pm/model'
import { blockPlainText, collectFootnotes, FOOTNOTE_NODE, getChapters } from '@/features/editor'
import { blockCheckText } from '@/features/spellcheck'
import { resolveFootnoteOptions } from '@/shared/book'
import { useStore } from '@/shared/store'
import { countText } from '@/shared/text'
import { isInlineHidden } from '@/shared/track-changes'
import type { ParagraphIndex } from './paragraph-index'

/**
 * What the writer attaches with the + chips, and what the read tools read (design, "Chat panel" and
 * Settled points 7 and 8). Numbers are the ones the writer sees: `page` as the page indicator shows it
 * (layout page index + 1), `chapter` as the navigation pane numbers chapters (getChapters index + 1).
 * `selection` is a document range.
 */
export type Attachment = { kind: 'page'; page: number } | { kind: 'chapter'; chapter: number } | { kind: 'selection'; from: number; to: number } | { kind: 'manuscript' }

/** No Markup: what is checked and sent (decision 1cedc290, like export). */
const VIEW = 'none'

export const SCENE_BREAK_LINE = '[scene break]'

/** The document range of an attachment now; null when it names nothing (no such page or chapter). */
export function attachmentRange(a: Attachment, doc: PMNode): { from: number; to: number } | null {
  const end = doc.content.size
  switch (a.kind) {
    case 'page': {
      const page = useStore.getState().layout.pages[a.page - 1]
      return page ? { from: Math.max(0, Math.min(page.from, end)), to: Math.max(0, Math.min(page.to, end)) } : null
    }
    case 'chapter': {
      const c = getChapters(doc)[a.chapter - 1]
      return c ? { from: c.from, to: c.to } : null
    }
    case 'selection':
      return { from: Math.max(0, Math.min(a.from, a.to, end)), to: Math.min(Math.max(a.from, a.to), end) }
    case 'manuscript':
      return { from: 0, to: end }
  }
}

/** "Page 41", "Chapter 3: The Storm" (the title only when `doc` is given), "Selection", "Whole manuscript". */
export function attachmentLabel(a: Attachment, doc?: PMNode): string {
  switch (a.kind) {
    case 'page':
      return `Page ${a.page}`
    case 'chapter': {
      const title = doc ? getChapters(doc)[a.chapter - 1]?.title.replace(/\s+/g, ' ').trim() : ''
      return title ? `Chapter ${a.chapter}: ${title}` : `Chapter ${a.chapter}`
    }
    case 'selection':
      return 'Selection'
    case 'manuscript':
      return 'Whole manuscript'
  }
}

/** One paragraph as the tutor reads it. */
export interface ParagraphText {
  id: string
  /** Position before the paragraph. */
  pos: number
  node: PMNode
  /** No Markup text, clipped to the range when `part`. */
  text: string
  part: boolean
  footnotes: { label: string; text: string }[]
}

/**
 * The non-empty paragraphs (textblocks) in `[from, to)`, and the scene breaks between them (null
 * entries). With `clip`, a paragraph the range cuts is cut to it (a selection); without, a paragraph
 * the range touches is read whole (a page that starts mid-paragraph).
 */
export function paragraphsIn(idx: ParagraphIndex, from: number, to: number, clip: boolean): (ParagraphText | null)[] {
  const doc = idx.editor.state.doc
  const out: (ParagraphText | null)[] = []
  if (to <= from) return out
  const notes = collectFootnotes(doc, resolveFootnoteOptions(useStore.getState().book.footnotes), VIEW)
  const labels = new Map(notes.map((n) => [n.pos, n.label]))
  doc.nodesBetween(from, to, (node, pos) => {
    if (node.type.name === 'sceneBreak') {
      out.push(null)
      return false
    }
    if (!node.isTextblock) return true
    const { text: full, segments } = blockCheckText(node, pos)
    let text = full
    let part = false
    if (clip) {
      text = ''
      for (const s of segments) {
        const a = Math.max(s.pos, from)
        const b = Math.min(s.pos + s.length, to)
        if (b > a) text += full.slice(s.offset + (a - s.pos), s.offset + (b - s.pos))
      }
      part = text !== full
    }
    const footnotes: ParagraphText['footnotes'] = []
    node.forEach((child, offset) => {
      const at = pos + 1 + offset
      if (child.type.name !== FOOTNOTE_NODE || isInlineHidden(child, VIEW)) return
      if (clip && (at < from || at >= to)) return
      const noteText = blockPlainText(child, { markupView: VIEW }).trim()
      if (noteText) footnotes.push({ label: labels.get(at) ?? String(footnotes.length + 1), text: noteText })
    })
    if (text.trim() === '' && footnotes.length === 0) return false
    out.push({ id: idx.idFor(pos), pos, node, text, part, footnotes })
    return false
  })
  return out
}

/** "[p12] text" lines (footnotes as "[p12 footnote 3] note" after their paragraph) and their word count. */
export function formatParagraphs(list: readonly (ParagraphText | null)[]): { text: string; words: number } {
  const lines: string[] = []
  let words = 0
  for (const p of list) {
    if (!p) {
      if (lines.length && lines[lines.length - 1] !== SCENE_BREAK_LINE) lines.push(SCENE_BREAK_LINE)
      continue
    }
    const oneLine = p.text.replace(/\n/g, ' ')
    lines.push(`[${p.id}${p.part ? ' part' : ''}] ${oneLine}`)
    words += countText(p.text).words
    for (const f of p.footnotes) {
      lines.push(`[${p.id} footnote ${f.label}] ${f.text.replace(/\n/g, ' ')}`)
      words += countText(f.text).words
    }
  }
  return { text: lines.join('\n'), words }
}

/**
 * The text of an attachment as the tutor is sent it: one "[pN] paragraph text" line per paragraph, in
 * the No Markup view (tracked deletions out, insertions in; decision 1cedc290), footnotes included after
 * their paragraph; comments and other re-write versions are not part of the text. `words` counts the
 * text alone (not the ids). Empty when the attachment names nothing.
 */
export function attachmentText(a: Attachment, idx: ParagraphIndex): { text: string; words: number } {
  const doc = idx.editor.state.doc
  const range = attachmentRange(a, doc)
  if (!range) return { text: '', words: 0 }
  return formatParagraphs(paragraphsIn(idx, range.from, range.to, a.kind === 'selection'))
}

/** Text of the book must not open or close a block: `<manuscript` / `</manuscript` are escaped. */
const escapeBody = (text: string) => text.replace(/<(?=\/?manuscript\b)/gi, '&lt;')
const escapeAttr = (text: string) => text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')

/**
 * The attached context layer: each attachment in its own clearly delimited block,
 * `<manuscript source="Chapter 3: The Storm">…</manuscript>`. The charter tells the model that what is
 * inside is data, never instructions; text inside cannot close the block early.
 */
export function wrapAttachments(list: readonly Attachment[], idx: ParagraphIndex): string {
  const doc = idx.editor.state.doc
  return list
    .map((a) => `<manuscript source="${escapeAttr(attachmentLabel(a, doc))}">\n${escapeBody(attachmentText(a, idx).text)}\n</manuscript>`)
    .join('\n\n')
}
