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

/** Every tracked change in the document, in document order of first appearance. O(document). */
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
    return true
  })
  return [...byId.values()]
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

function resolve(state: EditorState, filter: Filter, mode: Mode): Transaction | null {
  const tr = state.tr.setMeta(TRACK_SKIP_META, true)
  const schema = state.schema
  const doc = state.doc

  // 1. Inline: marks first (positions never move), then the removed text, last to first.
  const deletions: [number, number][] = []
  const markOps: (() => void)[] = []
  doc.descendants((node, pos) => {
    if (!node.isInline) return true
    const end = pos + node.nodeSize
    const onNode = !node.isText && !node.isLeaf
    for (const m of node.marks) {
      if (!isTrackingMark(m) || !filter(m.attrs.id)) continue
      const name = m.type.name
      const remove = (name === INSERTION_MARK && mode === 'reject') || (name === DELETION_MARK && mode === 'accept')
      if (remove) {
        deletions.push([pos, end])
        continue
      }
      if (name === FORMAT_CHANGE_MARK && mode === 'reject') {
        const before = ((m.attrs.before as unknown[]) ?? []).map((j) => schema.markFromJSON(j))
        const current = node.marks.filter((x) => !isTrackingMark(x) && x.type.name !== 'comment')
        markOps.push(() => {
          for (const x of current) if (!x.isInSet(before)) tr.removeMark(pos, end, x)
          for (const x of before) if (!x.isInSet(current)) tr.addMark(pos, end, x)
        })
      }
      markOps.push(() => (onNode ? tr.removeNodeMark(pos, m) : tr.removeMark(pos, end, m)))
    }
    return true
  })
  for (const op of markOps) op()
  for (const [a, b] of mergeRanges(deletions).reverse()) tr.delete(a, b)

  // 2. Blocks (on the result of 1), last to first.
  const blocks: { pos: number; attrs: Record<string, unknown>; type: PMNode['type']; marks: readonly Mark[]; join: boolean }[] = []
  tr.doc.descendants((node, pos) => {
    if (node.isInline) return false
    if (!(TRACKED_STYLE_ATTR in node.attrs)) return true
    const ins = node.attrs[TRACKED_INSERT_ATTR] as ChangeStamp | null
    const del = node.attrs[TRACKED_DELETE_ATTR] as ChangeStamp | null
    const style = node.attrs[TRACKED_STYLE_ATTR] as StyleChangeStamp | null
    const hitIns = !!ins && filter(ins.id)
    const hitDel = !!del && filter(del.id)
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
function inRange(state: EditorState, from: number, to: number): Filter {
  const ids = new Set(listChanges(state.doc).filter((c) => c.from < to && c.to > from || (from === to && c.from <= from && c.to >= to)).map((c) => c.id))
  return (x) => typeof x === 'string' && ids.has(x)
}

/** Accept one change (all its marks and blocks). */
export const acceptChange = (state: EditorState, id: string) => resolve(state, one(id), 'accept')
/** Reject one change. */
export const rejectChange = (state: EditorState, id: string) => resolve(state, one(id), 'reject')
/** Accept every change. */
export const acceptAll = (state: EditorState) => resolve(state, all, 'accept')
/** Reject every change. */
export const rejectAll = (state: EditorState) => resolve(state, all, 'reject')
/** Accept every change touching [from, to) (or containing `from` when the range is empty). */
export const acceptChangesInRange = (state: EditorState, from: number, to: number) => resolve(state, inRange(state, from, to), 'accept')
/** Reject every change touching [from, to). */
export const rejectChangesInRange = (state: EditorState, from: number, to: number) => resolve(state, inRange(state, from, to), 'reject')
