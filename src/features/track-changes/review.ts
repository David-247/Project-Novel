import type { Mark, Node as PMNode } from '@tiptap/pm/model'
import type { EditorState, Transaction } from '@tiptap/pm/state'
import { canJoin } from '@tiptap/pm/transform'
import {
  DELETION_MARK,
  FORMAT_CHANGE_MARK,
  INSERTION_MARK,
  TRACKED_DELETE_ATTR,
  TRACKED_INSERT_ATTR,
  TRACKED_STYLE_ATTR,
  TRACKING_MARKS,
} from '@/shared/track-changes'
import { hasTrackedChanges } from './has-changes'
import { TRACK_SKIP_META, type ChangeStamp, type StyleChangeStamp } from './record'

/**
 * Accept / reject core (docs/track-changes.md, "Accept and reject"). Pure: each function returns a
 * transaction on `state` (one undo step, never recorded as a change itself), or null when there is
 * nothing to do. The review UI (next ticket) is built on these.
 */

export type ChangeKind = 'insertion' | 'deletion' | 'formatChange' | 'styleChange' | 'blockInsert' | 'blockDelete'

export interface TrackedChange {
  id: string
  /** Kinds carried under this id (one user edit can insert text and a paragraph break). */
  kinds: ChangeKind[]
  author: string
  date: string
  /** Document range covered by the change's marks and blocks. */
  from: number
  to: number
}

const MARK_KIND: Record<string, ChangeKind> = {
  [INSERTION_MARK]: 'insertion',
  [DELETION_MARK]: 'deletion',
  [FORMAT_CHANGE_MARK]: 'formatChange',
}
const ATTR_KIND: Record<string, ChangeKind> = {
  [TRACKED_INSERT_ATTR]: 'blockInsert',
  [TRACKED_DELETE_ATTR]: 'blockDelete',
  [TRACKED_STYLE_ATTR]: 'styleChange',
}

const isTrackingMark = (m: Mark) => TRACKING_MARKS.includes(m.type.name)

/** Every tracked change in the document, in document order of first appearance. O(blocks holding changes). */
export function listChanges(doc: PMNode): TrackedChange[] {
  const byId = new Map<string, TrackedChange>()
  const add = (id: unknown, kind: ChangeKind, author: unknown, date: unknown, from: number, to: number) => {
    if (typeof id !== 'string' || !id) return
    const c = byId.get(id)
    if (!c) {
      byId.set(id, { id, kinds: [kind], author: String(author ?? ''), date: String(date ?? ''), from, to })
      return
    }
    if (!c.kinds.includes(kind)) c.kinds.push(kind)
    if (from < c.from) c.from = from
    if (to > c.to) c.to = to
  }
  doc.descendants((node, pos) => {
    for (const [attr, kind] of Object.entries(ATTR_KIND)) {
      const v = node.attrs[attr] as ChangeStamp | null | undefined
      if (v) add(v.id, kind, v.author, v.date, pos, pos + node.nodeSize)
    }
    for (const m of node.marks) if (isTrackingMark(m)) add(m.attrs.id, MARK_KIND[m.type.name], m.attrs.author, m.attrs.date, pos, pos + node.nodeSize)
    // Skip what holds no change (cached per immutable node): O(changed blocks) on a big manuscript.
    return !node.isLeaf && hasTrackedChanges(node)
  })
  return [...byId.values()]
}

/** The authors of the changes in the document, in order of first appearance (empty names left out). */
export function listAuthors(changes: readonly TrackedChange[]): string[] {
  return [...new Set(changes.map((c) => c.author).filter((a) => a !== ''))]
}

const changeIdsOf = (m: readonly Mark[]) => m.filter(isTrackingMark).map((x) => x.attrs.id as unknown).filter((x): x is string => typeof x === 'string' && !!x)
const blockIdsOf = (node: PMNode) =>
  Object.keys(ATTR_KIND)
    .map((a) => (node.attrs[a] as ChangeStamp | null | undefined)?.id)
    .filter((x): x is string => typeof x === 'string' && !!x)

/**
 * The change at a collapsed caret `pos` (the one Accept / Reject at the caret act on), or null.
 * Inline changes first: the text after the caret, then the text before it (the innermost mark, i.e.
 * the last one, when changes overlap: deleted text inside an insertion is the deletion). Then a
 * selected or adjacent break (a leaf block with a change), then the change on the boundary or style of
 * the textblock holding the caret.
 */
export function changeIdAt(doc: PMNode, pos: number): string | null {
  const $pos = doc.resolve(Math.max(0, Math.min(doc.content.size, pos)))
  for (const n of [$pos.nodeAfter, $pos.nodeBefore]) {
    if (!n?.isInline) continue
    const ids = changeIdsOf(n.marks)
    if (ids.length) return ids[ids.length - 1]
  }
  for (const n of [$pos.nodeAfter, $pos.nodeBefore]) {
    if (n?.isBlock && n.isLeaf) {
      const ids = blockIdsOf(n)
      if (ids.length) return ids[0]
    }
  }
  for (let d = $pos.depth; d > 0; d--) {
    const ids = blockIdsOf($pos.node(d))
    if (ids.length) return ids[0]
  }
  return null
}

/** Number of tracked changes (distinct ids) in the document. */
export const countChanges = (state: EditorState): number => listChanges(state.doc).length

type Mode = 'accept' | 'reject'
type Filter = (id: unknown) => boolean

function mergeRanges(ranges: [number, number][]): [number, number][] {
  ranges.sort((a, b) => a[0] - b[0])
  const out: [number, number][] = []
  for (const r of ranges) {
    const last = out[out.length - 1]
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1])
    else out.push([r[0], r[1]])
  }
  return out
}

/** Remove the boundary before the block at `pos`: join it to the textblock before, or remove it. */
function removeBoundary(tr: Transaction, pos: number) {
  const node = tr.doc.nodeAt(pos)
  if (!node) return
  const $pos = tr.doc.resolve(pos)
  if (node.isLeaf || node.content.size === 0) {
    if ($pos.parent.childCount > 1) tr.delete(pos, pos + node.nodeSize)
    return
  }
  if ($pos.nodeBefore?.isTextblock && canJoin(tr.doc, pos)) tr.join(pos)
}

/**
 * `clip`: only the part of each inline change inside [from, to) is resolved (the rest stays pending,
 * same id); a footnote reference (an atom) and block-level changes (boundaries, breaks, styles) that
 * the range touches are resolved whole.
 */
function resolve(state: EditorState, filter: Filter, mode: Mode, clip?: { from: number; to: number }): Transaction | null {
  const tr = state.tr.setMeta(TRACK_SKIP_META, true)
  const schema = state.schema
  const doc = state.doc

  // 1. Inline: marks first (positions never move), then the removed text, last to first.
  const deletions: [number, number][] = []
  const markOps: (() => void)[] = []
  doc.descendants((node, pos) => {
    if (!node.isInline) return hasTrackedChanges(node)
    let a = pos
    let b = pos + node.nodeSize
    if (clip) {
      if (b <= clip.from || a >= clip.to) return true
      // Text is split at the range's ends; an atom (a footnote) is one unit.
      if (node.isText) {
        a = Math.max(a, clip.from)
        b = Math.min(b, clip.to)
      }
    }
    const onNode = !node.isText && !node.isLeaf
    for (const m of node.marks) {
      if (!isTrackingMark(m) || !filter(m.attrs.id)) continue
      const name = m.type.name
      const remove = (name === INSERTION_MARK && mode === 'reject') || (name === DELETION_MARK && mode === 'accept')
      if (remove) {
        deletions.push([a, b])
        continue
      }
      if (name === FORMAT_CHANGE_MARK && mode === 'reject') {
        const before = ((m.attrs.before as unknown[]) ?? []).map((j) => schema.markFromJSON(j))
        const current = node.marks.filter((x) => !isTrackingMark(x) && x.type.name !== 'comment')
        markOps.push(() => {
          for (const x of current) if (!x.isInSet(before)) tr.removeMark(a, b, x)
          for (const x of before) if (!x.isInSet(current)) tr.addMark(a, b, x)
        })
      }
      markOps.push(() => (onNode ? tr.removeNodeMark(a, m) : tr.removeMark(a, b, m)))
    }
    return true
  })
  for (const op of markOps) op()
  for (const [a, b] of mergeRanges(deletions).reverse()) tr.delete(a, b)

  // 2. Blocks (on the result of 1), last to first. With a range: the blocks it touches.
  const range = clip && { from: tr.mapping.map(clip.from, -1), to: tr.mapping.map(clip.to, 1) }
  const blocks: { pos: number; attrs: Record<string, unknown>; type: PMNode['type']; marks: readonly Mark[]; join: boolean }[] = []
  tr.doc.descendants((node, pos) => {
    if (node.isInline || !hasTrackedChanges(node)) return false
    if (range && (pos >= range.to || pos + node.nodeSize <= range.from)) return false
    if (!(TRACKED_STYLE_ATTR in node.attrs)) return true
    const ins = node.attrs[TRACKED_INSERT_ATTR] as ChangeStamp | null
    const del = node.attrs[TRACKED_DELETE_ATTR] as ChangeStamp | null
    const style = node.attrs[TRACKED_STYLE_ATTR] as StyleChangeStamp | null
    // A paragraph mark (the boundary before a textblock: a split or join) only when the range
    // includes the boundary itself, as in Word, where the mark ends the previous paragraph: the range
    // starts at or before `pos` and goes past it. A selection starting at the block's first letter
    // does not include it. A break (a leaf block) and a style change: whenever the range touches it.
    const markInRange = !range || node.isLeaf || (range.from <= pos && range.to > pos)
    const hitIns = !!ins && markInRange && filter(ins.id)
    const hitDel = !!del && markInRange && filter(del.id)
    const hitStyle = !!style && filter(style.id)
    if (!hitIns && !hitDel && !hitStyle) return !node.isTextblock
    let type = node.type
    let attrs: Record<string, unknown> = { ...node.attrs }
    if (hitIns) attrs[TRACKED_INSERT_ATTR] = null
    if (hitDel) attrs[TRACKED_DELETE_ATTR] = null
    if (hitStyle) {
      attrs[TRACKED_STYLE_ATTR] = null
      const beforeType = schema.nodes[style.beforeType]
      if (mode === 'reject' && beforeType) {
        type = beforeType
        attrs = { ...style.beforeAttrs, [TRACKED_INSERT_ATTR]: attrs[TRACKED_INSERT_ATTR], [TRACKED_DELETE_ATTR]: attrs[TRACKED_DELETE_ATTR], [TRACKED_STYLE_ATTR]: null }
      }
    }
    const join = (hitIns && mode === 'reject') || (hitDel && mode === 'accept')
    blocks.push({ pos, attrs, type, marks: node.marks, join })
    return !node.isTextblock
  })
  // 2a. Attributes, and the blocks that go away whole (breaks, empty blocks), last to first. Removing
  // those first matters: a break inserted mid-paragraph sits between the two halves, which can only
  // join once it is gone (Mod-Enter in "abcd", then reject: "abcd" again).
  const joins: number[] = []
  const start = tr.steps.length
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i]
    try {
      tr.setNodeMarkup(b.pos, b.type, b.attrs, b.marks)
    } catch {
      tr.setNodeMarkup(b.pos, undefined, { ...tr.doc.nodeAt(b.pos)!.attrs, [TRACKED_STYLE_ATTR]: null })
    }
    if (!b.join) continue
    const node = tr.doc.nodeAt(b.pos)!
    if (node.isLeaf || node.content.size === 0) removeBoundary(tr, b.pos)
    else joins.push(b.pos)
  }
  // 2b. Joins (positions mapped over 2a), last to first.
  const after = tr.mapping.slice(start)
  for (const pos of joins) removeBoundary(tr, after.map(pos, 1))
  return tr.docChanged ? tr : null
}

const one = (id: string): Filter => (x) => x === id
const all: Filter = (x) => typeof x === 'string'
/** Changes containing a collapsed caret at `pos` (resolved whole). */
function atCaret(state: EditorState, pos: number): Filter {
  // What the caret is actually on: the marks of the inline nodes beside it, an adjacent break, the
  // blocks holding it (never a change whose pieces merely lie on both sides, with plain text between).
  const doc = state.doc
  const $pos = doc.resolve(Math.max(0, Math.min(doc.content.size, pos)))
  const ids = new Set<string>()
  for (const n of [$pos.nodeAfter, $pos.nodeBefore]) {
    if (n?.isInline) changeIdsOf(n.marks).forEach((id) => ids.add(id))
    else if (n?.isBlock && n.isLeaf) blockIdsOf(n).forEach((id) => ids.add(id))
  }
  for (let d = $pos.depth; d > 0; d--) blockIdsOf($pos.node(d)).forEach((id) => ids.add(id))
  return (x) => typeof x === 'string' && ids.has(x)
}
/**
 * The range variants, as Word does: only the selected part of an inline change is accepted or
 * rejected (the rest stays pending with the same id, author and date); plain text between two pieces
 * of one change does not count; block-level changes the range touches are resolved whole. An empty
 * range resolves every change containing it, whole.
 */
function inRange(state: EditorState, from: number, to: number, mode: Mode): Transaction | null {
  if (from >= to) return resolve(state, atCaret(state, from), mode)
  return resolve(state, all, mode, { from, to })
}

/** Accept one change (all its marks and blocks). */
export const acceptChange = (state: EditorState, id: string) => resolve(state, one(id), 'accept')
/** Reject one change. */
export const rejectChange = (state: EditorState, id: string) => resolve(state, one(id), 'reject')
/** Accept every change. */
export const acceptAll = (state: EditorState) => resolve(state, all, 'accept')
/** Reject every change. */
export const rejectAll = (state: EditorState) => resolve(state, all, 'reject')
/** Accept the selected part of every change in [from, to) (see inRange; whole changes at an empty range). */
export const acceptChangesInRange = (state: EditorState, from: number, to: number) => inRange(state, from, to, 'accept')
/** Reject the selected part of every change in [from, to). */
export const rejectChangesInRange = (state: EditorState, from: number, to: number) => inRange(state, from, to, 'reject')

function byAuthor(state: EditorState, author: string): Filter {
  const ids = new Set(listChanges(state.doc).filter((c) => c.author === author).map((c) => c.id))
  return (x) => typeof x === 'string' && ids.has(x)
}
/** Accept every change by `author` (its marks and blocks; other authors' changes stay). */
export const acceptAllByAuthor = (state: EditorState, author: string) => resolve(state, byAuthor(state, author), 'accept')
/** Reject every change by `author`. */
export const rejectAllByAuthor = (state: EditorState, author: string) => resolve(state, byAuthor(state, author), 'reject')
