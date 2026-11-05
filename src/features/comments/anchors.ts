import type { Mark, Node as PMNode } from '@tiptap/pm/model'
import type { EditorState } from '@tiptap/pm/state'
import { DELETION_MARK, TRACKED_DELETE_ATTR } from '@/shared/track-changes'

/** The inline mark that anchors a thread: `comment` with attr `id` (docs/project-format.md). */
export const COMMENT_MARK = 'comment'

export interface Anchor {
  id: string
  /**
   * First and last position of the marked text (a thread split by edits spans all its pieces). Text
   * that is a pending tracked deletion counts only when the thread has no other text: after a
   * tracked cut and paste, or a tracked drag-move, the anchor is the new place, not both.
   */
  from: number
  to: number
  /** All of the anchor text is a pending tracked deletion (the text "has left" once accepted). */
  deletedOnly: boolean
}

interface Piece {
  id: string
  from: number
  to: number
  deleted: boolean
}

/** Marked pieces of one top-level block, relative to its content start. Cached by node identity. */
const blockCache = new WeakMap<PMNode, readonly Piece[]>()
const NONE: readonly Piece[] = []

function commentIds(marks: readonly Mark[]): string[] | null {
  let ids: string[] | null = null
  for (const m of marks) {
    if (m.type.name === COMMENT_MARK && typeof m.attrs.id === 'string') (ids ??= []).push(m.attrs.id)
  }
  return ids
}

function blockPieces(block: PMNode): readonly Piece[] {
  const hit = blockCache.get(block)
  if (hit) return hit
  let out: Piece[] | null = null
  if (!block.isLeaf) {
    const blockDeleted = !!block.attrs[TRACKED_DELETE_ATTR]
    block.descendants((node, pos) => {
      if (!node.isInline) return true
      const ids = commentIds(node.marks)
      if (ids) {
        out ??= []
        const deleted = blockDeleted || node.marks.some((m) => m.type.name === DELETION_MARK)
        for (const id of ids) out.push({ id, from: pos, to: pos + node.nodeSize, deleted })
      }
      // An inline node with content (a footnote) may carry marked text of its own.
      return !node.isLeaf
    })
  }
  const pieces = out ?? NONE
  blockCache.set(block, pieces)
  return pieces
}

let lastDoc: PMNode | null = null
let lastAnchors: ReadonlyMap<string, Anchor> = new Map()

/**
 * Every anchored thread id with its range, in document order. O(top-level blocks) for a document
 * whose blocks were seen before (only changed blocks are scanned); the last result is cached.
 */
export function collectAnchors(doc: PMNode): ReadonlyMap<string, Anchor> {
  if (doc === lastDoc) return lastAnchors
  const out = new Map<string, Anchor>()
  doc.forEach((block, offset) => {
    const pieces = blockPieces(block)
    if (pieces === NONE) return
    const base = offset + 1
    for (const p of pieces) {
      const a = out.get(p.id)
      if (!a) out.set(p.id, { id: p.id, from: base + p.from, to: base + p.to, deletedOnly: p.deleted })
      else if (a.deletedOnly && !p.deleted) {
        // The first live piece: deleted pieces no longer count.
        a.from = base + p.from
        a.to = base + p.to
        a.deletedOnly = false
      } else if (a.deletedOnly || !p.deleted) {
        a.from = Math.min(a.from, base + p.from)
        a.to = Math.max(a.to, base + p.to)
      }
    }
  })
  lastDoc = doc
  lastAnchors = out
  return out
}

/** Anchors sorted by position (Next / Previous Comment, the drawer's document order). */
export function anchorsInOrder(doc: PMNode): Anchor[] {
  return [...collectAnchors(doc).values()].sort((a, b) => a.from - b.from || a.to - b.to)
}

/**
 * Thread ids whose marked text touches `pos` (the caret): marks of the text before and after it,
 * innermost (shortest anchor) first.
 */
export function commentIdsAt(state: EditorState, pos: number): string[] {
  const $pos = state.doc.resolve(Math.min(Math.max(0, pos), state.doc.content.size))
  const ids = new Set<string>()
  for (const n of [$pos.nodeAfter, $pos.nodeBefore]) {
    if (n) for (const id of commentIds(n.marks) ?? []) ids.add(id)
  }
  if (ids.size < 2) return [...ids]
  const anchors = collectAnchors(state.doc)
  return [...ids].sort((a, b) => span(anchors.get(a)) - span(anchors.get(b)))
}

const span = (a: Anchor | undefined) => (a ? a.to - a.from : Infinity)
