import type { Node as PMNode } from '@tiptap/pm/model'
import type { Transaction } from '@tiptap/pm/state'
import { Mapping } from '@tiptap/pm/transform'
import { chapterIndexAt, defaultStyleIdFor, effectiveStyleId, getChapters, getResolvedStyles, type Editor } from '@/features/editor'
import { countLines as paginationLines } from '@/features/pagination'
import { blockCheckText } from '@/features/spellcheck'
import { chapterRoles } from '@/shared/book'

/**
 * Where something is, for the writer: chapter and paragraph, both 1-based. The chapter numbers are the
 * navigation pane's (chapter 0 is the front matter, before the first chapter title); the paragraph is
 * counted among the chapter's non-empty paragraphs, its title and number blocks left out. `line` is the
 * layout line within the paragraph from the current pagination (a label only); null when there is no
 * position or no layout.
 */
export interface Location {
  chapter: number
  paragraph: number
  line: number | null
}

/**
 * Session-scoped paragraph ids ("p1", "p2"…). Blocks have no persistent ids, and none are added
 * (design, Settled point 6): ids are minted as the tutor's tools first meet a paragraph and are carried
 * through later edits with ProseMirror mapping, as outline/identity.ts carries its entries.
 *
 * - `resolve(id)`: the paragraph's range `[from, to)` (the node, from just before it) in the document
 *   now; 'changed' once any edit has touched its content (or deleted it), so a correction is never
 *   applied at a shifted position (Review Focus 2); 'unknown' for an id never minted.
 * - `map(tr)`: the owner passes every transaction of the editor, appended ones included, in order
 *   (`followEditor(idx)` does that). A transaction that was not passed is detected (the documents no
 *   longer chain), and every id minted before it then answers 'changed': safe, never shifted.
 */
export interface ParagraphIndex {
  /** The id of the paragraph (textblock) holding `pos`, minting one when the paragraph has none. */
  idFor(pos: number): string
  resolve(id: string): { from: number; to: number } | 'changed' | 'unknown'
  /** `pos`, when given, is a position in the paragraph for the line; otherwise `line` is null. */
  locationOf(id: string, pos?: number): Location
  map(tr: Transaction): void
  /** The editor the ids belong to. */
  readonly editor: Editor
}

export interface ParagraphIndexOptions {
  /** Layout lines touched by `[from, to)`, null without a layout (default: the pagination slice's). */
  countLines?: (range: { from: number; to: number }) => number | null
}

interface Entry {
  id: string
  /** Position before the paragraph, as of `at` maps of the session mapping. */
  pos: number
  at: number
  node: PMNode
  changed: boolean
}

export function createParagraphIndex(editor: Editor, options: ParagraphIndexOptions = {}): ParagraphIndex {
  const countLines = options.countLines ?? paginationLines
  const mapping = new Mapping()
  /** The document after the last mapped transaction. */
  let doc = editor.state.doc
  let minted = 0
  const entries = new Map<string, Entry>()
  /** Paragraph position now -> id, valid while `byPosAt === mapping.maps.length` and `byPosDoc === doc`. */
  let byPos = new Map<number, string>()
  let byPosAt = -1

  /** Edits made without `map`: positions can no longer be carried, so nothing minted before is trusted. */
  function sync() {
    const now = editor.state.doc
    if (now === doc) return
    for (const e of entries.values()) e.changed = true
    doc = now
    byPosAt = -1
  }

  /** Carry `e` to the document now (in place); false once an edit touched its content. */
  function carry(e: Entry): boolean {
    if (e.changed) return false
    const maps = mapping.maps
    let from = e.pos
    let to = e.pos + e.node.nodeSize
    for (let i = e.at; i < maps.length; i++) {
      const m = maps[i]
      let touched = false
      // Ranges in this map's input coordinates. The content is (from, to - 1]: typing at its end counts,
      // inserting a block just before or after the paragraph does not.
      m.forEach((oldStart, oldEnd) => {
        if (oldStart <= to - 1 && oldEnd >= from + 1) touched = true
      })
      const a = m.mapResult(from, 1)
      const b = m.mapResult(to, -1)
      if (touched || a.deletedAcross || b.deletedAcross || b.pos - a.pos !== e.node.nodeSize) {
        e.changed = true
        return false
      }
      from = a.pos
      to = b.pos
    }
    // Belt and braces: the document holds the same paragraph there.
    if (!doc.nodeAt(from)?.eq(e.node)) {
      e.changed = true
      return false
    }
    e.pos = from
    e.at = maps.length
    return true
  }

  function positions(): Map<number, string> {
    if (byPosAt === mapping.maps.length) return byPos
    byPos = new Map()
    for (const e of entries.values()) if (carry(e)) byPos.set(e.pos, e.id)
    byPosAt = mapping.maps.length
    return byPos
  }

  /** The position before the textblock holding `pos`. */
  function blockAt(pos: number): number {
    const node = doc.nodeAt(pos)
    if (node?.isTextblock) return pos
    const $p = doc.resolve(pos)
    for (let d = $p.depth; d > 0; d--) if ($p.node(d).isTextblock) return $p.before(d)
    throw new Error(`No paragraph at position ${pos}.`)
  }

  function locate(pos: number, at?: number): Location {
    const chapters = getChapters(doc)
    const index = chapterIndexAt(chapters, pos)
    const start = index < 0 ? 0 : chapters[index].from
    const roles = chapterRoles(getResolvedStyles())
    let paragraph = 0
    let done = false
    doc.nodesBetween(start, Math.min(pos + 1, doc.content.size), (node, p) => {
      if (done) return false
      if (!node.isTextblock) return true
      if (p > pos) {
        done = true
        return false
      }
      const styled = node.type.name === 'paragraph' || node.type.name === 'heading'
      const id = effectiveStyleId(node)
      const role = styled ? roles.get(id) ?? roles.get(defaultStyleIdFor(node.attrs, node.type.name)) : undefined
      if (p === pos || (role !== 'title' && role !== 'number' && blockCheckText(node, p).text.trim() !== '')) paragraph++
      return false
    })
    const line = at === undefined ? null : countLines({ from: pos + 1, to: Math.max(pos + 1, at) + 1 })
    return { chapter: index + 1, paragraph, line }
  }

  return {
    editor,
    idFor(pos) {
      sync()
      const at = blockAt(pos)
      const known = positions().get(at)
      if (known) return known
      const id = `p${++minted}`
      entries.set(id, { id, pos: at, at: mapping.maps.length, node: doc.nodeAt(at)!, changed: false })
      byPos.set(at, id)
      return id
    },
    resolve(id) {
      const e = entries.get(id)
      if (!e) return 'unknown'
      sync()
      return carry(e) ? { from: e.pos, to: e.pos + e.node.nodeSize } : 'changed'
    },
    locationOf(id, pos) {
      const e = entries.get(id)
      if (!e) return { chapter: 0, paragraph: 0, line: null }
      sync()
      if (carry(e)) return locate(e.pos, pos)
      // Changed: where it was, carried as far as the edits allow (a label only).
      const near = Math.min(mapping.slice(e.at).map(e.pos, 1), doc.content.size)
      return { ...locate(near), line: null }
    },
    map(tr) {
      if (tr.before !== doc) {
        // A transaction was missed: positions cannot be carried across it.
        for (const e of entries.values()) e.changed = true
      } else if (tr.docChanged) {
        mapping.appendMapping(tr.mapping)
      }
      doc = tr.doc
      byPosAt = -1
    },
  }
}

/** Feed every transaction of the index's editor (appended ones too) to `idx.map`. Returns unsubscribe. */
export function followEditor(idx: ParagraphIndex): () => void {
  const onTransaction = ({ transaction, appendedTransactions }: { transaction: Transaction; appendedTransactions: Transaction[] }) => {
    idx.map(transaction)
    for (const tr of appendedTransactions) idx.map(tr)
  }
  idx.editor.on('transaction', onTransaction)
  return () => {
    idx.editor.off('transaction', onTransaction)
  }
}
