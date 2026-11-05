import { Fragment, Slice, type Mark, type Node as PMNode, type NodeType, type Schema } from '@tiptap/pm/model'
import { AllSelection, NodeSelection, Selection, TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state'
import { AddMarkStep, AttrStep, RemoveMarkStep, ReplaceAroundStep, ReplaceStep, StepMap, type Step } from '@tiptap/pm/transform'
import {
  DELETION_MARK,
  FORMAT_CHANGE_MARK,
  INSERTION_MARK,
  TRACKED_DELETE_ATTR,
  TRACKED_INSERT_ATTR,
  TRACKED_STYLE_ATTR,
  TRACKING_BLOCK_ATTRS,
  TRACKING_MARKS,
} from '@/shared/track-changes'

/**
 * The recorder: rewrites a user transaction made while Track Changes is on into its tracked form
 * (docs/track-changes.md, "Recording"). Pure: `trackTransaction(state, tr, author)` returns a new
 * transaction built on the same state, which replaces `tr` before it is applied (the extension's
 * dispatch hook), so one user edit stays one transaction and one undo step.
 */

export interface Author {
  name: string
  color?: string | null
}

/** Attributes of a change (marks and block attributes). */
export interface ChangeStamp {
  id: string
  author: string
  authorColor?: string | null
  date: string
}

/** Transactions carrying this meta are never rewritten (accept / reject, document loads, tests). */
export const TRACK_SKIP_META = 'nvTrackChangesSkip'
/** Set on transactions the recorder produced. */
export const TRACKED_META = 'nvTracked'

/** Marks the recorder never tracks as formatting: its own, and the comments ticket's. */
const UNTRACKED_FORMAT_MARKS = new Set([...TRACKING_MARKS, 'comment'])

let counter = 0
/** A new change id (unique per document in practice: time, counter and a random part). */
export function newChangeId(): string {
  counter = (counter + 1) % 1_679_616
  return `c${Date.now().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

/** Ids of changes made in this session: typing next to one of your own extends it (Word behaviour). */
const sessionIds = new Set<string>()
/** Forget the session's changes (tests). */
export function resetTrackingSession(): void {
  sessionIds.clear()
}

const isTracking = (m: Mark) => TRACKING_MARKS.includes(m.type.name)
const markOf = (node: PMNode | null | undefined, name: string) => node?.marks.find((m) => m.type.name === name)

interface Ctx {
  schema: Schema
  author: string
  color: string | null
  date: string
  ins: Mark | null
  del: Mark | null
  fmtId: string | null
  /** IME composition in progress: inserted text is left unmarked and reported in `deferred`. */
  composing: boolean
  /** Unmarked text this author is composing (doc positions of the state): counts as own insertion. */
  pending: readonly (readonly [number, number])[]
  deferred: { from: number; to: number; step: number }[]
}

function stamp(ctx: Ctx, id = newChangeId()): ChangeStamp {
  sessionIds.add(id)
  const s: ChangeStamp = { id, author: ctx.author, date: ctx.date }
  if (ctx.color) s.authorColor = ctx.color
  return s
}

function changeMark(ctx: Ctx, name: string): Mark {
  const s = stamp(ctx)
  return ctx.schema.marks[name].create({ ...s, authorColor: ctx.color })
}

const ownSession = (m: Mark | undefined, ctx: Ctx) => !!m && m.attrs.author === ctx.author && sessionIds.has(m.attrs.id)

/** The node's insertion was made by this author: deleting it really removes it. */
function ownInsertion(node: PMNode, ctx: Ctx): boolean {
  return node.marks.some((m) => m.type.name === INSERTION_MARK && m.attrs.author === ctx.author)
}

// ---- Slices ------------------------------------------------------------------------------------

function cleanNode(n: PMNode): PMNode {
  const marks = n.marks.some(isTracking) ? n.marks.filter((m) => !isTracking(m)) : n.marks
  let attrs: Record<string, unknown> = n.attrs
  if (TRACKING_BLOCK_ATTRS.some((a) => n.attrs[a] != null)) {
    attrs = { ...n.attrs }
    for (const a of TRACKING_BLOCK_ATTRS) if (a in attrs) attrs[a] = null
  }
  if (n.isText) return marks === n.marks ? n : n.mark(marks)
  const content = n.isLeaf ? n.content : cleanFragment(n.content)
  if (marks === n.marks && attrs === n.attrs && content === n.content) return n
  return n.type.create(attrs, content, marks)
}

function cleanFragment(frag: Fragment): Fragment {
  let changed = false
  const out: PMNode[] = []
  frag.forEach((n) => {
    const c = cleanNode(n)
    if (c !== n) changed = true
    out.push(c)
  })
  return changed ? Fragment.fromArray(out) : frag
}

/** The slice without tracking marks or tracking block attributes (pasted or typed content). */
export function cleanSlice(slice: Slice): Slice {
  const content = cleanFragment(slice.content)
  return content === slice.content ? slice : new Slice(content, slice.openStart, slice.openEnd)
}

// ---- Replace -------------------------------------------------------------------------------------

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

function setBlockAttr(tr: Transaction, pos: number, attr: string, value: unknown) {
  const node = tr.doc.nodeAt(pos)
  if (!node || !(attr in node.attrs)) return
  tr.setNodeMarkup(pos, undefined, { ...node.attrs, [attr]: value }, node.marks)
}

interface ReplaceResult {
  /** Size of the content kept (deletion-marked) between the range start and the insertion. */
  retained: number
}

/** Marks [F, T) deleted (really removing the author's own insertions), then inserts `slice` after it. */
function trackReplace(tr: Transaction, F: number, T: number, slice: Slice, ctx: Ctx): ReplaceResult {
  let at = T
  if (F < T) {
    const doc = tr.doc
    const removals: [number, number][] = []
    const markRanges: [number, number][] = []
    const nodeMarks: number[] = []
    const blockDeletes: number[] = []
    const blockOp = (node: PMNode, pos: number) => {
      const ins = node.attrs[TRACKED_INSERT_ATTR] as ChangeStamp | null
      if (ins && ins.author === ctx.author) {
        if (node.isLeaf) return void removals.push([pos, pos + node.nodeSize])
        const before = doc.resolve(pos).nodeBefore
        if (before?.isTextblock) return void removals.push([pos - 1, pos + 1])
      }
      if (!node.attrs[TRACKED_DELETE_ATTR] && TRACKED_DELETE_ATTR in node.attrs) blockDeletes.push(pos)
    }
    doc.nodesBetween(F, T, (node, pos) => {
      if (node.isInline) {
        const a = Math.max(F, pos)
        const b = Math.min(T, pos + node.nodeSize)
        if (a >= b) return false
        const covered = a === pos && b === pos + node.nodeSize
        // Inside a footnote's text (or across part of it): its content is handled on its own.
        if (!node.isText && !node.isLeaf && !covered) return true
        if (ownInsertion(node, ctx) || ctx.pending.some(([x, y]) => x <= a && b <= y)) removals.push([a, b])
        else if (!markOf(node, DELETION_MARK)) {
          if (node.isText || node.isLeaf) markRanges.push([a, b])
          else nodeMarks.push(pos)
        }
        return false
      }
      if (node.isBlock && node.isLeaf) {
        if (F <= pos && T >= pos + node.nodeSize) blockOp(node, pos)
        return false
      }
      // A textblock whose opening lies inside the range: the boundary before it is deleted.
      if (node.isTextblock && F <= pos && T >= pos + 1) blockOp(node, pos)
      return true
    })
    if (markRanges.length || nodeMarks.length) {
      const before = doc.resolve(F).nodeBefore
      const after = doc.resolve(T).nodeAfter
      const adjacent = [markOf(before, DELETION_MARK), markOf(after, DELETION_MARK)].find((m) => ownSession(m, ctx))
      const mark = adjacent ?? (ctx.del ??= changeMark(ctx, DELETION_MARK))
      for (const [a, b] of mergeRanges(markRanges)) tr.addMark(a, b, mark)
      for (const p of nodeMarks) tr.addNodeMark(p, mark)
    }
    if (blockDeletes.length) {
      const s = stamp(ctx, (ctx.del ??= changeMark(ctx, DELETION_MARK)).attrs.id)
      for (const p of blockDeletes) setBlockAttr(tr, p, TRACKED_DELETE_ATTR, s)
    }
    const first = tr.steps.length
    for (const [a, b] of mergeRanges(removals).reverse()) tr.delete(a, b)
    at = new StepMapping(tr, first).map(T, -1)
  }
  const retained = at - F
  if (slice.size > 0) insertTracked(tr, at, cleanSlice(slice), ctx)
  return { retained }
}

/** Maps positions through the steps added to `tr` since `from`. */
class StepMapping {
  constructor(
    private tr: Transaction,
    private from: number,
  ) {}
  map(pos: number, assoc: number): number {
    return this.tr.mapping.slice(this.from).map(pos, assoc)
  }
}

/** The inline content with `mark` added wherever its parent allows it (recursing into footnotes). */
function markInline(frag: Fragment, mark: Mark, parent: NodeType): Fragment {
  const out: PMNode[] = []
  frag.forEach((n) => {
    let node = n
    if (!n.isText && !n.isLeaf) node = n.copy(markInline(n.content, mark, n.type))
    out.push(parent.allowsMarkType(mark.type) ? node.mark(mark.addToSet(node.marks)) : node)
  })
  return Fragment.fromArray(out)
}

/**
 * Inline-only content (typing, Replace): inserted with its insertion mark already on it, one step
 * instead of an insert plus an AddMarkStep (Replace All: 2 steps per match, not 3).
 */
function insertMarkedInline(tr: Transaction, at: number, slice: Slice, ctx: Ctx): boolean {
  if (ctx.composing || slice.openStart !== 0 || slice.openEnd !== 0) return false
  let inline = true
  slice.content.forEach((n) => {
    if (!n.isInline) inline = false
  })
  const $at = tr.doc.resolve(at)
  if (!inline || !$at.parent.inlineContent) return false
  const mark = insertionMarkFor(tr.doc, at, at, ctx)
  return !tr.maybeStep(new ReplaceStep(at, at, new Slice(markInline(slice.content, mark, $at.parent.type), 0, 0))).failed
}

function insertTracked(tr: Transaction, at: number, slice: Slice, ctx: Ctx) {
  if (insertMarkedInline(tr, at, slice, ctx)) return
  const first = tr.steps.length
  const res = tr.maybeStep(new ReplaceStep(at, at, slice))
  if (res.failed) tr.replace(at, at, slice)
  if (tr.steps.length === first) return
  const m = new StepMapping(tr, first)
  const from = m.map(at, -1)
  const to = m.map(at, 1)
  if (to <= from) return
  const doc = tr.doc
  let inline = false
  const blocks: number[] = []
  doc.nodesBetween(from, to, (node, pos) => {
    if (node.isInline) {
      inline = true
      return false
    }
    if ((node.isTextblock || node.isLeaf) && pos >= from && pos < to && TRACKED_INSERT_ATTR in node.attrs) blocks.push(pos)
    return !node.isLeaf
  })
  let mark: Mark | null = null
  if (inline) {
    // While an IME composes, re-wrapping its text node in a mark span cancels or doubles the
    // composition (Safari): the mark is added when the composition ends (markComposed).
    if (ctx.composing && blocks.length === 0) return void ctx.deferred.push({ from, to, step: tr.steps.length })
    mark = insertionMarkFor(doc, from, to, ctx)
    tr.addMark(from, to, mark)
  }
  if (blocks.length) {
    const s = stamp(ctx, (mark ?? (ctx.ins ??= changeMark(ctx, INSERTION_MARK))).attrs.id)
    for (const p of blocks) setBlockAttr(tr, p, TRACKED_INSERT_ATTR, s)
  }
}

/** The insertion mark for new text at [from, to): the author's adjacent change of this session, or a new one. */
function insertionMarkFor(doc: PMNode, from: number, to: number, ctx: Ctx): Mark {
  const $from = doc.resolve(from)
  return insertionMarkBetween($from.nodeBefore, doc.resolve(to).nodeAfter, $from.parent, ctx)
}

/** insertionMarkFor, given the nodes on either side of the new text and its parent. */
function insertionMarkBetween(before: PMNode | null | undefined, after: PMNode | null | undefined, parent: PMNode, ctx: Ctx): Mark {
  let adjacent = [markOf(before, INSERTION_MARK), markOf(after, INSERTION_MARK)].find((mk) => ownSession(mk, ctx))
  if (!adjacent && !before) {
    // Typing at the start of a paragraph this session inserted: the same change as the paragraph.
    const block = parent.attrs[TRACKED_INSERT_ATTR] as ChangeStamp | null
    if (block && block.author === ctx.author && sessionIds.has(block.id))
      adjacent = ctx.schema.marks[INSERTION_MARK].create({ ...block, authorColor: block.authorColor ?? null })
  }
  return adjacent ?? (ctx.ins ??= changeMark(ctx, INSERTION_MARK))
}

/** Meta on a tracked transaction: ranges (in its doc) of composed text left unmarked for now. */
export const DEFERRED_INSERT_META = 'nvTrackDeferred'
/** Meta on a transaction applied untracked because the rewrite failed. */
export const TRACK_FAILED_META = 'nvTrackFailed'

/**
 * Marks composed text (ranges in `tr.doc`, from DEFERRED_INSERT_META) as inserted, in `tr`: the end
 * of an IME composition. Text already marked (or deleted) in the range is left as it is.
 */
export function markComposed(tr: Transaction, ranges: readonly (readonly [number, number])[], author: Author, date = new Date().toISOString()): void {
  const ctx = newCtx(tr.doc.type.schema, author, date)
  const size = tr.doc.content.size
  for (const [a, b] of ranges) {
    const from = Math.max(0, Math.min(size, a))
    const to = Math.max(from, Math.min(size, b))
    if (to <= from) continue
    const marks: [number, number][] = []
    tr.doc.nodesBetween(from, to, (n, pos) => {
      if (n.isInline && (n.isText || n.isLeaf) && !markOf(n, INSERTION_MARK) && !markOf(n, DELETION_MARK))
        marks.push([Math.max(from, pos), Math.min(to, pos + n.nodeSize)])
      // Into blocks and into inline nodes with content (a footnote's text).
      return !n.isText && !n.isLeaf
    })
    if (marks.length === 0) continue
    const mark = insertionMarkFor(tr.doc, from, to, ctx)
    for (const [x, y] of mergeRanges(marks)) tr.addMark(x, y, mark)
  }
}

function newCtx(schema: Schema, author: Author, date: string, composing = false, pending: Ctx['pending'] = []): Ctx {
  return { schema, author: author.name, color: author.color ?? null, date, ins: null, del: null, fmtId: null, composing, pending, deferred: [] }
}

// ---- Block attributes (paragraph styles and formatting) --------------------------------------------

/** A block's formatting: its type and attributes without the tracking ones. */
function formatOf(type: NodeType, attrs: Record<string, unknown>): { type: string; attrs: Record<string, unknown> } {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(attrs)) if (!TRACKING_BLOCK_ATTRS.includes(k)) out[k] = v ?? null
  return { type: type.name, attrs: out }
}
const sameFormat = (a: ReturnType<typeof formatOf>, b: ReturnType<typeof formatOf>) =>
  a.type === b.type && JSON.stringify(a.attrs) === JSON.stringify(b.attrs)

export interface StyleChangeStamp extends ChangeStamp {
  beforeStyleId: string | null
  beforeType: string
  beforeAttrs: Record<string, unknown>
}

/**
 * Changes the block at `pos` to `type` / `attrs` through setNodeMarkup (never AttrStep: the styles
 * plugin follows setNodeMarkup) and records the earlier formatting in `trackedStyleChange`.
 */
function trackBlockMarkup(tr: Transaction, pos: number, type: NodeType, attrs: Record<string, unknown>, marks: readonly Mark[], ctx: Ctx): boolean {
  const old = tr.doc.nodeAt(pos)
  if (!old || !(TRACKED_STYLE_ATTR in old.attrs) || !(TRACKED_STYLE_ATTR in (type.spec.attrs ?? {}))) return false
  const was = formatOf(old.type, old.attrs)
  const now = formatOf(type, attrs)
  const next: Record<string, unknown> = { ...attrs }
  for (const a of TRACKING_BLOCK_ATTRS) next[a] = old.attrs[a] ?? null
  const ins = old.attrs[TRACKED_INSERT_ATTR] as ChangeStamp | null
  if (!sameFormat(was, now) && !(ins && ins.author === ctx.author)) {
    const existing = old.attrs[TRACKED_STYLE_ATTR] as StyleChangeStamp | null
    if (existing) {
      if (sameFormat(now, { type: existing.beforeType, attrs: existing.beforeAttrs })) next[TRACKED_STYLE_ATTR] = null
    } else {
      next[TRACKED_STYLE_ATTR] = {
        ...stamp(ctx),
        beforeStyleId: (old.attrs.styleId as string | null | undefined) ?? null,
        beforeType: was.type,
        beforeAttrs: was.attrs,
      } satisfies StyleChangeStamp
    }
  }
  tr.setNodeMarkup(pos, type, next, marks)
  return true
}

function isSetNodeMarkup(step: ReplaceAroundStep): boolean {
  return (
    step.insert === 1 &&
    step.gapFrom === step.from + 1 &&
    step.gapTo === step.to - 1 &&
    step.slice.openStart === 0 &&
    step.slice.openEnd === 0 &&
    step.slice.content.childCount === 1
  )
}

// ---- Inline formatting -------------------------------------------------------------------------------

const formatMarks = (marks: readonly Mark[]) => marks.filter((m) => !UNTRACKED_FORMAT_MARKS.has(m.type.name)).map((m) => m.toJSON())
const sameMarks = (a: unknown, b: unknown) => JSON.stringify(a ?? []) === JSON.stringify(b ?? [])

function trackMarkStep(tr: Transaction, step: AddMarkStep | RemoveMarkStep, ctx: Ctx) {
  const { from, to, mark } = step
  if (UNTRACKED_FORMAT_MARKS.has(mark.type.name)) {
    tr.maybeStep(step)
    return
  }
  const segs: { a: number; b: number; before: unknown[]; fc: Mark | undefined }[] = []
  tr.doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isText && !node.isLeaf) return true
    if (!node.isInline) return false
    const a = Math.max(from, pos)
    const b = Math.min(to, pos + node.nodeSize)
    // Formatting your own insertion (or deleted text) is not a change of its own.
    if (a < b && !ownInsertion(node, ctx) && !markOf(node, DELETION_MARK))
      segs.push({ a, b, before: formatMarks(node.marks), fc: markOf(node, FORMAT_CHANGE_MARK) })
    return false
  })
  if (tr.maybeStep(step).failed) return
  const byBefore = new Map<string, Mark>()
  for (const s of segs) {
    const after = formatMarks(tr.doc.nodeAt(s.a)?.marks ?? [])
    if (s.fc) {
      if (sameMarks(after, s.fc.attrs.before)) tr.removeMark(s.a, s.b, s.fc)
      continue
    }
    if (sameMarks(after, s.before)) continue
    const key = JSON.stringify(s.before)
    let fc = byBefore.get(key)
    if (!fc) {
      ctx.fmtId ??= newChangeId()
      fc = ctx.schema.marks[FORMAT_CHANGE_MARK].create({ ...stamp(ctx, ctx.fmtId), before: s.before })
      byBefore.set(key, fc)
    }
    tr.addMark(s.a, s.b, fc)
  }
}

// ---- Replace All in one pass ----------------------------------------------------------------------

/**
 * From this many steps, a Replace All-shaped transaction (descending text replacements) is recorded
 * in one pass: one ReplaceStep per match (its text, marked deleted, then the replacement, marked
 * inserted) instead of an AddMarkStep plus an insertion, built from the original document grouped
 * by textblock, without resolving positions per match. The result equals the per-match path
 * (record.test.ts).
 */
export const BATCH_MIN_STEPS = 16

interface BatchMatch {
  /** Index of the step in the transaction. */
  step: number
  F: number
  T: number
  slice: Slice
}

/** Consecutive children [c0, c1] of one textblock (text only) holding matches, ascending. */
interface BatchRun {
  parent: PMNode
  /** Content start of the parent. */
  start: number
  /** Start offset of every child of the parent, relative to `start`. */
  offsets: number[]
  c0: number
  c1: number
  matches: BatchMatch[]
}

function childOffsets(parent: PMNode): number[] {
  const out: number[] = []
  parent.forEach((_n, off) => out.push(off))
  return out
}

/** Index of the child covering relative offset `rel` (the last child starting at or before it). */
function childAt(offsets: readonly number[], rel: number): number {
  let lo = 0
  let hi = offsets.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (offsets[mid] <= rel) lo = mid
    else hi = mid - 1
  }
  return lo
}

/**
 * The runs of a Replace All-shaped transaction (`steps` descending), or null when it does not fit
 * the batch (a match touching the next one, a match over anything but text, block content, an IME
 * composition): the per-match path records it then.
 */
function planBatch(doc: PMNode, steps: readonly ReplaceStep[], ctx: Ctx): BatchRun[] | null {
  if (ctx.composing || ctx.pending.length) return null
  const runs: BatchRun[] = []
  let run: BatchRun | null = null
  let prevF = Infinity
  for (let i = 0; i < steps.length; i++) {
    const { from: F, to: T, slice } = steps[i]
    if (F >= T || T >= prevF || slice.openStart !== 0 || slice.openEnd !== 0) return null
    for (let k = 0; k < slice.content.childCount; k++) if (!slice.content.child(k).isInline) return null
    prevF = F
    let c0 = -1
    let c1 = -1
    if (run && F >= run.start && T <= run.start + run.parent.content.size) {
      const a = childAt(run.offsets, F - run.start)
      const b = childAt(run.offsets, T - 1 - run.start)
      // In this textblock itself (not in a footnote's text inside it): both ends are in its text.
      if (run.parent.child(a).isText && run.parent.child(b).isText) {
        c0 = a
        c1 = b
      }
    }
    if (c0 < 0 || !run) {
      const $F = doc.resolve(F)
      const parent = $F.parent
      const start = $F.start()
      if (!parent.inlineContent || T > $F.end()) return null
      const offsets = childOffsets(parent)
      c0 = childAt(offsets, F - start)
      c1 = childAt(offsets, T - 1 - start)
      run = { parent, start, offsets, c0, c1, matches: [] }
      runs.push(run)
    }
    for (let c = c0; c <= c1; c++) if (!run.parent.child(c).isText) return null
    // Joins the run when only text lies between this match and the run.
    let joins = true
    for (let c = c1 + 1; c < run.c0; c++) if (!run.parent.child(c).isText) joins = false
    if (!joins) {
      run = { parent: run.parent, start: run.start, offsets: run.offsets, c0, c1, matches: [] }
      runs.push(run)
    }
    run.c0 = Math.min(run.c0, c0)
    run.matches.push({ step: i, F, T, slice })
  }
  for (const r of runs) r.matches.reverse()
  return runs
}

/** A text node with `mark` added, where its parent allows it (as AddMarkStep does). */
function withMark(node: PMNode, mark: Mark, parent: PMNode): PMNode {
  return parent.type.allowsMarkType(mark.type) ? node.mark(mark.addToSet(node.marks)) : node
}

/** Append, joining text with the same marks (as ProseMirror's own steps leave it). */
function pushInline(out: PMNode[], node: PMNode) {
  const last = out[out.length - 1]
  if (last && last.isText && node.isText && last.sameMarkup(node)) out[out.length - 1] = node.type.schema.text(last.text! + node.text!, last.marks)
  else out.push(node)
}

/**
 * Records a Replace All-shaped transaction in `out` (see BATCH_MIN_STEPS), with the rules of
 * trackReplace: matched text is marked deleted (your own insertions are really removed) and the
 * replacement goes in after it as an insertion. One ReplaceStep per match, covering only the match,
 * so every position outside the matches (a comment draft, decorations, bookmarks) maps exactly.
 * Returns the retained size per step, or null when the transaction does not fit or a step could not
 * be applied (then `out` may hold some steps: the caller starts again from a fresh transaction).
 */
function trackReplaceBatch(out: Transaction, steps: readonly ReplaceStep[], ctx: Ctx): number[] | null {
  const runs = planBatch(out.doc, steps, ctx)
  if (!runs) return null
  const retained = new Array<number>(steps.length).fill(0)
  // Runs come in descending order, and matches are taken last first: each step's positions are
  // still valid in `out` when it is applied.
  for (const run of runs) {
    const { parent, start, offsets } = run
    // The unchanged neighbours of a match: matches never touch, and earlier ones are not applied yet.
    const nodeBefore = (pos: number) => (pos - start <= 0 ? null : parent.child(childAt(offsets, pos - start - 1)))
    const nodeAfter = (pos: number) => (pos - start >= parent.content.size ? null : parent.child(childAt(offsets, pos - start)))
    for (let mi = run.matches.length - 1; mi >= 0; mi--) {
      const m = run.matches[mi]
      const content: PMNode[] = []
      for (let c = childAt(offsets, m.F - start); c < parent.childCount; c++) {
        const cs = start + offsets[c]
        if (cs >= m.T) break
        const child = parent.child(c)
        const a = Math.max(cs, m.F)
        const b = Math.min(cs + child.nodeSize, m.T)
        if (ownInsertion(child, ctx)) continue // your own insertion: really removed
        const piece = child.cut(a - cs, b - cs)
        if (markOf(child, DELETION_MARK)) pushInline(content, piece)
        else {
          const adjacent = [markOf(nodeBefore(m.F), DELETION_MARK), markOf(nodeAfter(m.T), DELETION_MARK)].find((mk) => ownSession(mk, ctx))
          pushInline(content, withMark(piece, adjacent ?? (ctx.del ??= changeMark(ctx, DELETION_MARK)), parent))
        }
        retained[m.step] += b - a
      }
      const slice = cleanSlice(m.slice)
      if (slice.size > 0) {
        // Next to the new text: the last piece kept of the match, else the text before the match.
        const before = retained[m.step] > 0 ? content[content.length - 1] : nodeBefore(m.F)
        const mark = insertionMarkBetween(before, nodeAfter(m.T), parent, ctx)
        markInline(slice.content, mark, parent.type).forEach((n) => pushInline(content, n))
      }
      if (out.maybeStep(new ReplaceStep(m.F, m.T, new Slice(Fragment.fromArray(content), 0, 0))).failed) return null
    }
  }
  return retained
}

// ---- The transaction ------------------------------------------------------------------------------

/** Retained (deletion-marked) runs in the coordinates of the original transaction's current doc. */
interface Run {
  pos: number
  len: number
}

function mapThroughRuns(runs: readonly Run[], pos: number, assoc: number): number {
  let out = pos
  for (const r of runs) {
    if (r.pos < pos || (r.pos === pos && assoc > 0)) out += r.len
    else break
  }
  return out
}

function runsMap(runs: readonly Run[]): StepMap {
  return new StepMap(runs.flatMap((r) => [r.pos, 0, r.len]))
}

/** Every step a ReplaceStep, each one before (below) the previous: positions all valid in the start doc. */
function descendingReplaces(steps: readonly Step[]): boolean {
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i]
    if (!(s instanceof ReplaceStep)) return false
    if (i > 0 && s.to > (steps[i - 1] as ReplaceStep).from) return false
  }
  return true
}

function copyMeta(from: Transaction, to: Transaction) {
  const meta = (from as unknown as { meta: Record<string, unknown> }).meta
  for (const k of Object.keys(meta)) to.setMeta(k, meta[k])
  to.setTime(from.time)
  if (from.scrolledIntoView) to.scrollIntoView()
  if (from.storedMarksSet) to.setStoredMarks(from.storedMarks ? from.storedMarks.filter((m) => !isTracking(m)) : null)
  to.setMeta(TRACKED_META, true)
}

function mapSelection(tr: Transaction, out: Transaction, runs: readonly Run[], assoc: number) {
  const sel = tr.selection
  const doc = out.doc
  const map = (p: number) => Math.min(doc.content.size, mapThroughRuns(runs, p, assoc))
  try {
    if (sel instanceof AllSelection) out.setSelection(new AllSelection(doc))
    else if (sel instanceof NodeSelection) {
      const p = map(sel.from)
      const node = doc.nodeAt(p)
      out.setSelection(node && NodeSelection.isSelectable(node) ? NodeSelection.create(doc, p) : Selection.near(doc.resolve(p)))
    } else {
      const anchor = map(sel.anchor)
      const head = sel.empty ? anchor : map(sel.head)
      const $a = doc.resolve(anchor)
      const $h = doc.resolve(head)
      out.setSelection($a.parent.inlineContent && $h.parent.inlineContent ? TextSelection.between($a, $h) : Selection.near($h))
    }
  } catch {
    out.setSelection(Selection.near(doc.resolve(Math.min(doc.content.size, out.selection.from))))
  }
}

/** True when `tr` should be recorded (changes the document; not an undo / redo, a load or a review action). */
export function shouldTrack(tr: Transaction): boolean {
  if (!tr.docChanged) return false
  if (tr.getMeta(TRACK_SKIP_META) || tr.getMeta(TRACKED_META)) return false
  if (tr.getMeta('history$')) return false
  if (tr.getMeta('addToHistory') === false) return false
  return true
}

/**
 * The tracked form of `tr` (made on `state`):
 * - inserted content gets an `insertion` mark (typing next to your own insertion of this session
 *   extends it), new blocks a `trackedInsert` attribute;
 * - deleted content stays, with a `deletion` mark (block boundaries and breaks: `trackedDelete`),
 *   except your own insertions, which are really removed; new text goes after the deleted text;
 * - formatting marks (bold, italic, fonts…) get a `formatChange` mark holding the earlier marks;
 * - paragraph style / formatting changes (setNodeMarkup) get `trackedStyleChange`.
 * The selection is mapped onto the result: Backspace leaves the caret before the deleted text,
 * Delete and typing after it. If the rewrite fails, the transaction is returned unchanged.
 */
export interface TrackOptions {
  /** An IME composition is in progress: leave inserted text unmarked (DEFERRED_INSERT_META). */
  composing?: boolean
  /** Unmarked composed text of this author in `state.doc` (counts as own insertion). */
  pending?: readonly (readonly [number, number])[]
  /** Record a Replace All-shaped transaction run by run (default: from BATCH_MIN_STEPS steps). */
  batch?: boolean
}

export function trackTransaction(
  state: EditorState,
  tr: Transaction,
  author: Author,
  date = new Date().toISOString(),
  options: TrackOptions = {},
): Transaction {
  if (!shouldTrack(tr) || tr.before !== state.doc) return tr
  let out = state.tr
  try {
    const ctx = newCtx(state.schema, author, date, options.composing === true, options.pending ?? [])
    let runs: Run[] = []
    if (descendingReplaces(tr.steps)) {
      // Fast path (one step; Replace All): every step's positions are valid in `out` as it goes.
      const steps = tr.steps as ReplaceStep[]
      const batch = (options.batch ?? steps.length >= BATCH_MIN_STEPS) ? trackReplaceBatch(out, steps, ctx) : null
      // The batch gave up part way: record per match, from the start.
      if (!batch && out.steps.length) out = state.tr
      const retained: number[] = batch ?? steps.map((s) => trackReplace(out, s.from, s.to, s.slice, ctx).retained)
      let shift = 0
      for (let i = tr.steps.length - 1; i >= 0; i--) {
        const s = tr.steps[i] as ReplaceStep
        if (retained[i] > 0) runs.push({ pos: s.from + shift, len: retained[i] })
        shift += s.slice.size - (s.to - s.from)
      }
    } else {
      for (const step of tr.steps) runs = applyStep(out, step, runs, ctx)
    }
    copyMeta(tr, out)
    mapSelection(tr, out, runs, backspaceLike(state, tr) ? -1 : 1)
    if (ctx.deferred.length)
      out.setMeta(
        DEFERRED_INSERT_META,
        ctx.deferred.map((d) => {
          const m = out.mapping.slice(d.step)
          return [m.map(d.from, -1), m.map(d.to, 1)] as const
        }),
      )
    return out
  } catch (err) {
    console.error('[track-changes] could not record this edit; applied untracked', err)
    return tr.setMeta(TRACK_FAILED_META, true)
  }
}

function backspaceLike(state: EditorState, tr: Transaction): boolean {
  if (tr.steps.length !== 1) return false
  const s = tr.steps[0]
  return s instanceof ReplaceStep && s.slice.size === 0 && state.selection.empty && state.selection.head === s.to && s.from < s.to
}

/** General path: one original step, positions mapped over the deleted text kept so far. */
function applyStep(out: Transaction, step: Step, runs: Run[], ctx: Ctx): Run[] {
  if (step instanceof ReplaceStep) {
    const pure = step.from === step.to
    const F = mapThroughRuns(runs, step.from, 1)
    const T = pure ? F : Math.max(F, mapThroughRuns(runs, step.to, -1))
    const { retained } = trackReplace(out, F, T, step.slice, ctx)
    const delta = step.slice.size - (step.to - step.from)
    const next: Run[] = []
    let atFrom = 0
    for (const r of runs) {
      if (r.pos < step.from) next.push(r)
      else if (r.pos === step.from) atFrom += r.len
      else if (r.pos < step.to) continue // inside the replaced range: counted in `retained`
      else next.push({ pos: r.pos + delta, len: r.len })
    }
    if (atFrom + retained > 0) next.push({ pos: step.from, len: atFrom + retained })
    return next.sort((a, b) => a.pos - b.pos)
  }
  const mapped = step.map(runsMap(runs))
  if (mapped) {
    if (mapped instanceof ReplaceAroundStep && isSetNodeMarkup(mapped)) {
      const node = mapped.slice.content.firstChild!
      if (!trackBlockMarkup(out, mapped.from, node.type, node.attrs, node.marks, ctx)) out.maybeStep(mapped)
    } else if (mapped instanceof AttrStep) {
      const node = out.doc.nodeAt(mapped.pos)
      if (!node || !trackBlockMarkup(out, mapped.pos, node.type, { ...node.attrs, [mapped.attr]: mapped.value }, node.marks, ctx)) out.maybeStep(mapped)
    } else if (mapped instanceof AddMarkStep || mapped instanceof RemoveMarkStep) trackMarkStep(out, mapped, ctx)
    else out.maybeStep(mapped)
  }
  const map = step.getMap()
  return runs.map((r) => ({ pos: map.map(r.pos, 1), len: r.len }))
}
