import { Extension } from '@tiptap/core'
import { Fragment, Slice, type Node as PMNode } from '@tiptap/pm/model'
import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state'
import { AddMarkStep, AddNodeMarkStep, Mapping, RemoveMarkStep, RemoveNodeMarkStep, type Step } from '@tiptap/pm/transform'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'
import { TRACK_SKIP_META } from '@/features/track-changes'
import { BULK_EDIT_META, REWRITE_BLOCK_ATTR } from '@/shared/rewrite'
import { useStore } from '@/shared/store'
import { applyStateSteps, RewriteStateStep } from './step'

/**
 * The re-write anchor in the manuscript (docs/project-format.md, "rewrites.json"):
 *
 * - `rewriteId`, a block attribute on the top-level block types. Set with AttrStep (setNodeAttribute:
 *   its step map is empty, so positions, decorations and the undo history map through it for free, and
 *   the pagination does not drop its decorations for a chapter-long passage; the attribute is not
 *   formatting, so the style index need not see it), outside the undo history, with TRACK_SKIP_META
 *   (never a tracked change). Not parsed
 *   from HTML and not rendered, stripped from pasted and dropped slices (a drag-copy too), not kept
 *   on split: a copy never carries it. An open re-write's blocks that lose it (rejecting a tracked
 *   style change restores the attributes from before) get it back (appendTransaction).
 * - The lock: while a re-write is open (status 'open'), its passage (the run of top-level blocks
 *   carrying its anchor) is read-only. A filterTransaction refuses edits inside it, a beforeinput
 *   handler stops the browser from typing there, and the refusal raises a notice that offers to open
 *   the re-write. Programmatic edits pass: Replace All (BULK_EDIT_META), accept / reject
 *   (TRACK_SKIP_META), undo / redo (never blocked), and the re-write's own writes
 *   (REWRITE_ALLOW_META); when one of the first three changes the passage, the re-write is marked
 *   "original changed" (an undo also shows a short notice). Comments pass (the comment mark and thread steps): a
 *   locked passage can be commented on, like protected text in Word.
 * - Decorations: a side bar and a faint tint on the locked blocks (no box change, so the pagination
 *   measurement is untouched).
 */

/** Transaction meta `true`: written by the re-write feature itself (anchors, T9's apply); passes the lock. */
export const REWRITE_ALLOW_META = 'nvRewriteAllow'
const REFRESH_META = 'nvRewriteRefresh'

/** Top-level block types that can be part of a passage. */
export const ANCHOR_TYPES = ['paragraph', 'heading', 'bulletList', 'orderedList', 'pageBreak', 'sceneBreak'] as const

export interface LockedRange {
  id: string
  /** Position before the passage's first block and after its last one. */
  from: number
  to: number
}

/** An open re-write whose passage an allowed edit (an undo) removed: where it was, and its blocks. */
interface LostPassage {
  /** Where the passage was, mapped through every later edit. */
  at: number
  /** Its blocks as they were (an undo of the removal, a redo of the insertion, puts equal blocks back). */
  blocks: readonly PMNode[]
}

/** What an applied transaction did to open passages (reported by the plugin view, after every filter). */
type AnchorEvent = { kind: 'changed' | 'undo' | 'missing' | 'split' | 'restored'; id: string }

interface AnchorState {
  ranges: readonly LockedRange[]
  decorations: DecorationSet
  lost: ReadonlyMap<string, LostPassage>
  /** This dispatch's events (appended transactions add to their root's). */
  events: readonly AnchorEvent[]
  /**
   * Open / not open per anchor, as the history steps (RewriteStateStep: Keep, Discard, Reopen and their
   * undo / redo) set it, until the store says the same (it is updated after the dispatch).
   */
  overrides: ReadonlyMap<string, boolean>
  /** This dispatch's RewriteStateSteps, copied into the store by the plugin view. */
  stateSteps: readonly RewriteStateStep[]
}

export const rewriteAnchorKey = new PluginKey<AnchorState>('nvRewriteAnchor')

/**
 * Anchor ids of the re-writes that lock their passage (status 'open'): the store's, with the
 * resolution changes history steps made that the store does not show yet (`overrides`).
 */
function openAnchors(overrides?: ReadonlyMap<string, boolean>): ReadonlySet<string> {
  const set = new Set<string>()
  for (const r of useStore.getState().rewrite.rewrites) if (r.status === 'open') set.add(r.anchor)
  overrides?.forEach((open, anchor) => (open ? set.add(anchor) : set.delete(anchor)))
  return set
}

/** The open anchors in `state` (its history steps included). */
export function openAnchorsIn(state: EditorState): ReadonlySet<string> {
  return openAnchors(rewriteAnchorKey.getState(state)?.overrides)
}

const anchorSignature = () => [...openAnchors()].sort().join(' ')

const stateStepsOf = (tr: Transaction) => tr.steps.filter((s): s is RewriteStateStep => s instanceof RewriteStateStep)

/** `overrides` without the entries the store now agrees with, plus the steps of `tr`. */
function nextOverrides(overrides: ReadonlyMap<string, boolean>, steps: readonly RewriteStateStep[]): ReadonlyMap<string, boolean> {
  if (!overrides.size && !steps.length) return overrides
  const store = openAnchors()
  const out = new Map<string, boolean>()
  overrides.forEach((open, anchor) => {
    if (store.has(anchor) !== open) out.set(anchor, open)
  })
  for (const s of steps) out.set(s.anchor, s.opens)
  if (out.size === overrides.size && [...out].every(([k, v]) => overrides.get(k) === v)) return overrides
  return out
}

/**
 * Every run of top-level blocks carrying the anchor `anchor` (normally one; a programmatic edit can
 * split a passage). O(top-level blocks).
 */
export function passageRanges(doc: PMNode, anchor: string): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = []
  let open: { from: number; to: number } | null = null
  doc.forEach((node, offset) => {
    if (node.attrs[REWRITE_BLOCK_ATTR] === anchor) {
      if (open && open.to === offset) open.to = offset + node.nodeSize
      else out.push((open = { from: offset, to: offset + node.nodeSize }))
    } else open = null
  })
  return out
}

/**
 * The passage of `anchor` (its one run of blocks), or null when no block carries it or when the
 * blocks carrying it are not one run (an error: `passageProblem` says which). Never spans the text
 * between two runs.
 */
export function passageRange(doc: PMNode, anchor: string): { from: number; to: number } | null {
  const runs = passageRanges(doc, anchor)
  return runs.length === 1 ? runs[0] : null
}

/** Why passageRange(doc, anchor) is null: 'missing' (no block carries it), 'split' (more than one run); null when fine. */
export function passageProblem(doc: PMNode, anchor: string): 'missing' | 'split' | null {
  const n = passageRanges(doc, anchor).length
  return n === 0 ? 'missing' : n > 1 ? 'split' : null
}

/** `slice` without re-write anchors (pasted, dropped, drag-copied content is never part of a passage). */
export function stripAnchors(slice: Slice): Slice {
  let found = false
  slice.content.descendants((n) => {
    if (n.attrs[REWRITE_BLOCK_ATTR]) found = true
    return !found && !n.isTextblock
  })
  if (!found) return slice
  const strip = (fragment: Fragment): Fragment => {
    const out: PMNode[] = []
    fragment.forEach((n) => {
      if (n.isText || n.isInline) return void out.push(n)
      const attrs = n.attrs[REWRITE_BLOCK_ATTR] ? { ...n.attrs, [REWRITE_BLOCK_ATTR]: null } : n.attrs
      out.push(n.type.create(attrs, n.isTextblock ? n.content : strip(n.content), n.marks))
    })
    return Fragment.from(out)
  }
  return new Slice(strip(slice.content), slice.openStart, slice.openEnd)
}

function computeRanges(doc: PMNode, anchors: ReadonlySet<string>): LockedRange[] {
  if (anchors.size === 0) return []
  const out: LockedRange[] = []
  let last: LockedRange | null = null
  doc.forEach((node, offset) => {
    const id = node.attrs[REWRITE_BLOCK_ATTR] as string | null
    if (!id || !anchors.has(id)) {
      last = null
      return
    }
    if (last && last.id === id && last.to === offset) last.to = offset + node.nodeSize
    else out.push((last = { id, from: offset, to: offset + node.nodeSize }))
  })
  return out
}

function sameRanges(a: readonly LockedRange[], b: readonly LockedRange[]): boolean {
  return a.length === b.length && a.every((r, i) => r.id === b[i].id && r.from === b[i].from && r.to === b[i].to)
}

function buildDecorations(doc: PMNode, ranges: readonly LockedRange[]): DecorationSet {
  if (!ranges.length) return DecorationSet.empty
  const decos: Decoration[] = []
  for (const r of ranges) {
    doc.nodesBetween(r.from, r.to, (node, pos) => {
      if (pos < r.from) return true
      const first = pos === r.from
      const last = pos + node.nodeSize === r.to
      decos.push(
        Decoration.node(pos, pos + node.nodeSize, {
          class: `nv-rw-locked${first ? ' nv-rw-locked-first' : ''}${last ? ' nv-rw-locked-last' : ''}`,
          'data-rewrite-passage': r.id,
        }),
      )
      return false
    })
  }
  return DecorationSet.create(doc, decos)
}

const isCommentStep = (step: Step) =>
  (step instanceof AddMarkStep || step instanceof RemoveMarkStep || step instanceof AddNodeMarkStep || step instanceof RemoveNodeMarkStep) &&
  step.mark.type.name === 'comment'

/** [from, to] touched by a step in the doc it applies to, or null (a step that changes no content range). */
function stepRange(step: Step): [number, number] | null {
  // Comments may be added to and removed from locked text (thread steps have no range either).
  if (isCommentStep(step)) return null
  const s = step as unknown as { from?: unknown; to?: unknown; pos?: unknown }
  if (typeof s.from === 'number' && typeof s.to === 'number') return [s.from, s.to]
  if (typeof s.pos === 'number') return [s.pos, s.pos + 1]
  return null
}

/** The locked ranges a transaction's steps touch (inside them, not just at their outer edge). */
export function touchedRanges(tr: Transaction, ranges: readonly LockedRange[], first = false): LockedRange[] {
  const out: LockedRange[] = []
  if (!ranges.length) return out
  let current = ranges.map((r) => [r.from, r.to] as [number, number])
  for (const step of tr.steps) {
    const span = stepRange(step)
    if (span) {
      const [a, b] = span
      for (let i = 0; i < current.length; i++) {
        const [f, t] = current[i]
        if (t <= f || out.includes(ranges[i])) continue
        if (a === b ? a > f && a < t : a < t && b > f) {
          out.push(ranges[i])
          if (first) return out
        }
      }
    }
    const map = step.getMap()
    current = current.map(([f, t]) => [map.map(f, 1), map.map(t, -1)])
  }
  return out
}

/** The first locked range a transaction's steps touch, or null. */
export function touchedRange(tr: Transaction, ranges: readonly LockedRange[]): LockedRange | null {
  return touchedRanges(tr, ranges, true)[0] ?? null
}

/** Top-level blocks of `doc` in [from, to). */
function blocksIn(doc: PMNode, from: number, to: number): PMNode[] {
  const out: PMNode[] = []
  doc.nodesBetween(from, to, (node, pos) => {
    if (pos >= from) out.push(node)
    return false
  })
  return out
}

/** Same block, anchor aside (type, content, marks; attributes other than the anchor). */
function sameBlockIgnoringAnchor(a: PMNode, b: PMNode): boolean {
  if (a.type.name !== b.type.name || !a.content.eq(b.content) || !a.sameMarkup(a.type.create({ ...a.attrs }, null, b.marks))) return false
  for (const k of Object.keys(a.attrs)) if (k !== REWRITE_BLOCK_ATTR && a.attrs[k] !== b.attrs[k]) return false
  return true
}

let seq = 0
/** The user tried to edit the locked passage of `id`: the manuscript's notice offers to open it. */
function refused(id: string) {
  useStore.getState().rewriteActions.setNotice({ kind: 'locked', id, seq: ++seq })
}

/** Called (once per dispatch, after every filter) with the anchors whose passage a programmatic edit changed. */
let onOriginalChanged: ((anchor: string) => void) | null = null
export function setOriginalChangedHandler(fn: ((anchor: string) => void) | null): void {
  onOriginalChanged = fn
}

let onSideBarClick: ((anchor: string) => void) | null = null
/** A click on a locked passage's side bar (the left margin beside it): reopen its re-write. */
export function setSideBarClickHandler(fn: ((anchor: string) => void) | null): void {
  onSideBarClick = fn
}

/**
 * Edits the lock lets through: Replace All, accept / reject, and undo / redo (never blocked: the
 * history only undoes its top event, so refusing one would leave everything older stuck).
 */
function programmatic(tr: Transaction): boolean {
  return tr.getMeta(BULK_EDIT_META) === true || tr.getMeta(TRACK_SKIP_META) === true || !!tr.getMeta('history$')
}

/** Report one dispatch's events: "original changed", and the notice (a lost passage outranks an undo). */
function report(events: readonly AnchorEvent[]) {
  const ids = [...new Set(events.filter((e) => e.kind !== 'restored').map((e) => e.id))]
  for (const id of ids) onOriginalChanged?.(id)
  const pick = (k: AnchorEvent['kind']) => events.find((e) => e.kind === k)
  const lost = pick('missing') ?? pick('split')
  const undo = pick('undo')
  const actions = useStore.getState().rewriteActions
  if (lost) actions.setNotice({ kind: lost.kind as 'missing' | 'split', id: lost.id, seq: ++seq })
  else if (undo) actions.setNotice({ kind: 'undo', id: undo.id, seq: ++seq })
  // A passage anchored again: its "removed" notice is out of date.
  const notice = useStore.getState().rewrite.notice
  if (!lost && notice && (notice.kind === 'missing' || notice.kind === 'split') && events.some((e) => e.kind === 'restored' && e.id === notice.id)) {
    actions.setNotice(null)
  }
}

/** Some step of `tr` replaced or inserted at document position `pos` (in the doc before `tr`). */
function touchesPos(tr: Transaction, pos: number): boolean {
  let p = pos
  for (const step of tr.steps) {
    let hit = false
    step.getMap().forEach((oldStart, oldEnd) => {
      if (oldStart <= p && p <= oldEnd) hit = true
    })
    if (hit) return true
    p = step.getMap().map(p, -1)
  }
  return false
}

/**
 * Ranges (in the final document) that the undo / redo transactions among `trs` inserted with their own
 * steps. A lost passage is re-anchored only inside such a range: never on a block the user typed.
 */
function historyInsertions(trs: readonly Transaction[]): [number, number][] {
  const maps: { map: ReturnType<Step['getMap']>; history: boolean }[] = []
  for (const t of trs) for (const m of t.mapping.maps) maps.push({ map: m, history: !!t.getMeta('history$') })
  const all = new Mapping(maps.map((m) => m.map))
  const out: [number, number][] = []
  maps.forEach(({ map, history }, i) => {
    if (!history) return
    const rest = all.slice(i + 1)
    map.forEach((_os, _oe, ns, ne) => {
      if (ne > ns) out.push([rest.map(ns, -1), rest.map(ne, 1)])
    })
  })
  return out
}

/** Open anchors whose passage is missing or split now (the view and the list show it). */
function problems(ranges: readonly LockedRange[]): Record<string, 'missing' | 'split'> {
  const count = new Map<string, number>()
  for (const r of ranges) count.set(r.id, (count.get(r.id) ?? 0) + 1)
  const out: Record<string, 'missing' | 'split'> = {}
  for (const id of openAnchors()) {
    const n = count.get(id) ?? 0
    if (n !== 1) out[id] = n === 0 ? 'missing' : 'split'
  }
  return out
}

let onStateStepsMirrored: (() => void) | null = null
/** Set by commands.ts: called after the store took a step's change (rewrites.json is then unsaved). */
export function setStateStepsMirroredHandler(fn: (() => void) | null): void {
  onStateStepsMirrored = fn
}

/** Copy the resolution set by history steps into the store (a user change: saved with the manuscript). */
function mirrorStateSteps(steps: readonly RewriteStateStep[]) {
  const s = useStore.getState()
  const next = applyStateSteps(s.rewrite.rewrites, steps)
  if (next === s.rewrite.rewrites) return
  s.rewriteActions.changed(next)
  onStateStepsMirrored?.()
}

function selectionLocked(state: EditorState): LockedRange | null {
  const ranges = rewriteAnchorKey.getState(state)?.ranges ?? []
  const { from, to } = state.selection
  for (const r of ranges) if (from < r.to && to > r.from && !(from === to && (from <= r.from || from >= r.to))) return r
  return null
}

/** The locked passage holding the caret (or overlapping the selection), or null. */
export function lockedAtSelection(state: EditorState): LockedRange | null {
  return selectionLocked(state)
}

function createAnchorPlugin(): Plugin<AnchorState> {
  return new Plugin<AnchorState>({
    key: rewriteAnchorKey,
    state: {
      init: (_, state) => {
        const ranges = computeRanges(state.doc, openAnchors())
        return { ranges, decorations: buildDecorations(state.doc, ranges), lost: new Map(), events: [], overrides: new Map(), stateSteps: [] }
      },
      // Runs only for applied transactions (after every filter): the events reported by the view.
      apply(tr, value, oldState, state) {
        const appended = tr.getMeta('appendedTransaction') !== undefined
        const carried = appended ? value.events : []
        if (!tr.docChanged && !tr.getMeta(REFRESH_META))
          return (value.events.length || value.stateSteps.length) && !appended ? { ...value, events: [], stateSteps: [] } : value
        const own = stateStepsOf(tr)
        const overrides = nextOverrides(value.overrides, own)
        const stateSteps = own.length ? [...(appended ? value.stateSteps : []), ...own] : appended ? value.stateSteps : []
        // Anchors a step of this transaction resolved: their passage is let go, not lost.
        const resolved = new Set(own.filter((s) => !s.opens).map((s) => s.anchor))
        // O(top-level blocks) per edit, attribute reads only: microseconds on a 100k-word manuscript.
        const open = openAnchors(overrides)
        const ranges = computeRanges(state.doc, open)
        const events: AnchorEvent[] = [...carried]
        let lost = value.lost
        if (tr.docChanged || lost.size) {
          if (lost.size) {
            // Mapped through the edit. Dropped when the re-write is no longer open, or when another edit
            // (typing, paste, Replace All) changed that very spot: only the history may bring it back.
            const history = !!tr.getMeta('history$')
            const next = new Map<string, LostPassage>()
            lost.forEach((l, id) => {
              if (!open.has(id)) return
              if (tr.docChanged && !history && touchesPos(tr, l.at)) return
              next.set(id, tr.docChanged ? { ...l, at: tr.mapping.map(l.at, -1) } : l)
            })
            lost = next.size === lost.size && [...next].every(([id, l]) => value.lost.get(id) === l) ? value.lost : next
          }
        }
        if (tr.docChanged) {
          if (!tr.getMeta(REWRITE_ALLOW_META) && programmatic(tr)) {
            const kind = tr.getMeta('history$') ? 'undo' : 'changed'
            for (const r of touchedRanges(tr, value.ranges)) if (!resolved.has(r.id)) events.push({ kind, id: r.id })
          }
          // Passages this edit removed (or split): remembered, so a redo / undo that puts the blocks back re-anchors them.
          const now = new Set(ranges.map((r) => r.id))
          const runs = new Map<string, number>()
          for (const r of ranges) runs.set(r.id, (runs.get(r.id) ?? 0) + 1)
          const before = new Map<string, number>()
          for (const r of value.ranges) before.set(r.id, (before.get(r.id) ?? 0) + 1)
          for (const r of value.ranges) {
            if (!now.has(r.id) && !lost.has(r.id) && !resolved.has(r.id)) {
              if (lost === value.lost) lost = new Map(lost)
              ;(lost as Map<string, LostPassage>).set(r.id, { at: tr.mapping.map(r.from, -1), blocks: blocksIn(oldState.doc, r.from, r.to) })
              events.push({ kind: 'missing', id: r.id })
            }
          }
          for (const [id, n] of runs) if (n > 1 && (before.get(id) ?? 0) <= 1) events.push({ kind: 'split', id })
          for (const id of now) {
            if (lost.has(id)) {
              if (lost === value.lost) lost = new Map(lost)
              ;(lost as Map<string, LostPassage>).delete(id)
              events.push({ kind: 'restored', id })
            }
          }
        }
        const decorations = sameRanges(ranges, value.ranges)
          ? tr.docChanged
            ? value.decorations.map(tr.mapping, tr.doc)
            : value.decorations
          : buildDecorations(state.doc, ranges)
        return { ranges: sameRanges(ranges, value.ranges) ? value.ranges : ranges, decorations, lost, events, overrides, stateSteps }
      },
    },
    filterTransaction(tr, state) {
      if (!tr.docChanged || tr.getMeta(REWRITE_ALLOW_META)) return true
      const ranges = rewriteAnchorKey.getState(state)?.ranges
      if (!ranges?.length) return true
      const hit = touchedRange(tr, ranges)
      if (!hit) return true
      // Allowed edits are reported after every filter ran (plugin state events, the view).
      if (programmatic(tr)) return true
      refused(hit.id)
      return false
    },
    // An open re-write's block that lost its anchor (a programmatic edit restored attributes from
    // before it existed: rejecting a tracked style change) gets it back, outside the undo history.
    // A lost passage whose blocks an undo / redo put back where it was is anchored again.
    appendTransaction(trs, oldState, newState) {
      if (!trs.some((t) => t.docChanged) || trs.some((t) => t.getMeta(REWRITE_ALLOW_META))) return null
      const out = newState.tr
      const lost = rewriteAnchorKey.getState(newState)?.lost
      const openNow = openAnchorsIn(newState)
      // Blocks an undo / redo put back with the anchor of a re-write that is not open (resolved, or
      // gone): a stale anchor never stays in the manuscript (an undone Keep reopens its re-write in the
      // same step, so its anchor is open here and stays).
      if (trs.some((t) => t.getMeta('history$'))) {
        for (const [a, b] of historyInsertions(trs)) {
          newState.doc.nodesBetween(Math.max(0, a), Math.min(b, newState.doc.content.size), (node, pos) => {
            const id = node.attrs[REWRITE_BLOCK_ATTR] as string | null | undefined
            if (id && !openNow.has(id) && node.attrs[REWRITE_BLOCK_ATTR] !== undefined) out.setNodeAttribute(pos, REWRITE_BLOCK_ATTR, null)
            return false
          })
        }
      }
      if (lost?.size && trs.some((t) => t.getMeta('history$'))) {
        const inserted = historyInsertions(trs)
        lost.forEach((l, id) => {
          const $at = newState.doc.resolve(Math.min(l.at, newState.doc.content.size))
          if ($at.depth !== 0) return
          let index = $at.index(0)
          let pos = l.at
          for (const want of l.blocks) {
            const have = index < newState.doc.childCount ? newState.doc.child(index) : null
            if (!have || !sameBlockIgnoringAnchor(have, want)) return
            index++
            pos += have.nodeSize
          }
          // Only blocks this undo / redo itself put there.
          if (!inserted.some(([a, b]) => a <= l.at && pos <= b)) return
          setAnchor(out, l.at, pos, id)
        })
      }
      const old = rewriteAnchorKey.getState(oldState)?.ranges
      if (!old?.length) return out.docChanged ? out.setMeta(REWRITE_ALLOW_META, true).setMeta(TRACK_SKIP_META, true).setMeta('addToHistory', false) : null
      const mapping = new Mapping()
      for (const t of trs) mapping.appendMapping(t.mapping)
      for (const r of old) {
        // Resolved by a step of these transactions (an undone Reopen): let go.
        if (!openNow.has(r.id)) continue
        const from = mapping.map(r.from, 1)
        const to = mapping.map(r.to, -1)
        if (to <= from) continue
        newState.doc.nodesBetween(from, to, (node, pos) => {
          if (pos < from) return true
          if ((ANCHOR_TYPES as readonly string[]).includes(node.type.name) && node.attrs[REWRITE_BLOCK_ATTR] !== r.id) {
            out.setNodeAttribute(pos, REWRITE_BLOCK_ATTR, r.id)
          }
          return false
        })
      }
      return out.docChanged ? out.setMeta(REWRITE_ALLOW_META, true).setMeta(TRACK_SKIP_META, true).setMeta('addToHistory', false) : null
    },
    props: {
      decorations: (state) => rewriteAnchorKey.getState(state)?.decorations,
      // Paste and drop (a drag-copy inserts the dragged slice as it is): never a second passage.
      transformPasted: (slice) => stripAnchors(slice),
      handleDOMEvents: {
        beforeinput: (view, event) => {
          const hit = selectionLocked(view.state)
          if (!hit) return false
          event.preventDefault()
          refused(hit.id)
          return true
        },
        drop: (view, event) => {
          const at = view.posAtCoords({ left: (event as DragEvent).clientX, top: (event as DragEvent).clientY })
          const ranges = rewriteAnchorKey.getState(view.state)?.ranges ?? []
          const hit = at ? ranges.find((r) => at.pos > r.from && at.pos < r.to) : undefined
          if (!hit) return false
          event.preventDefault()
          refused(hit.id)
          return true
        },
      },
      handleClick: (_view, _pos, event) => {
        const el = (event.target as Element | null)?.closest?.('[data-rewrite-passage]') as HTMLElement | null
        if (!el || !onSideBarClick) return false
        // The side bar sits in the margin, left of the text: a click left of the block's box.
        if (event.clientX >= el.getBoundingClientRect().left) return false
        onSideBarClick(el.getAttribute('data-rewrite-passage')!)
        return true
      },
    },
    view(view: EditorView) {
      let signature = anchorSignature()
      const unsub = useStore.subscribe((s, prev) => {
        if (s.rewrite.rewrites === prev.rewrite.rewrites || view.isDestroyed) return
        const next = anchorSignature()
        if (next === signature) return
        signature = next
        // The store caught up with a history step (Keep, Discard, Reopen): the lock already follows it.
        const st = rewriteAnchorKey.getState(view.state)
        const fresh = computeRanges(view.state.doc, openAnchors(st?.overrides))
        if (!st || !sameRanges(fresh, st.ranges)) view.dispatch(view.state.tr.setMeta(REFRESH_META, {}).setMeta('addToHistory', false))
        // Which open re-writes lack their passage changes with the set of open re-writes too.
        syncProblems(view.state)
      })
      const syncProblems = (state: EditorState) => {
        const p = problems(rewriteAnchorKey.getState(state)?.ranges ?? [])
        const cur = useStore.getState().rewrite.problems
        if (JSON.stringify(p) !== JSON.stringify(cur)) useStore.getState().rewriteActions.setProblems(p)
      }
      syncProblems(view.state)
      const syncCaret = (state: EditorState) => {
        const id = selectionLocked(state)?.id ?? null
        if (useStore.getState().rewrite.caretIn !== id) useStore.getState().rewriteActions.setCaretIn(id)
      }
      syncCaret(view.state)
      return {
        update(v, prevState) {
          const before = rewriteAnchorKey.getState(prevState)
          const now = rewriteAnchorKey.getState(v.state)
          // Keep / Discard / Reopen, their undo and redo: rewrites.json follows the document.
          if (now && now.stateSteps !== before?.stateSteps && now.stateSteps.length) mirrorStateSteps(now.stateSteps)
          if (now?.events !== before?.events && now?.events.length) report(now.events)
          if (before?.ranges !== now?.ranges) syncProblems(v.state)
          if (!v.state.selection.eq(prevState.selection) || before?.ranges !== now?.ranges) syncCaret(v.state)
        },
        destroy() {
          unsub()
          if (useStore.getState().rewrite.caretIn !== null) useStore.getState().rewriteActions.setCaretIn(null)
        },
      }
    },
  })
}

export interface RewriteAnchorOptions {
  /**
   * A copy of the schema for another view (the comparison pages): the attribute only, no lock, no
   * decorations, no shortcut.
   */
  detached: boolean
}

let reWriteShortcut: (() => boolean) | null = null
/** Set by commands.ts: Re-write Passage… from the manuscript's keymap (macOS: Option changes the key). */
export function setRewriteShortcutHandler(fn: (() => boolean) | null): void {
  reWriteShortcut = fn
}

/** Re-write Passage… (Review). The editor keymap runs it from the manuscript. */
export const REWRITE_SHORTCUT = 'Mod-Alt-w'

/**
 * The `rewriteId` block attribute, the passage lock and its decorations. In the editor's extension
 * list; `RewriteAnchor.configure({ detached: true })` for the comparison pages.
 */
export const RewriteAnchor = Extension.create<RewriteAnchorOptions>({
  name: 'rewriteAnchor',

  addOptions() {
    return { detached: false }
  },

  addGlobalAttributes() {
    return [
      {
        types: [...ANCHOR_TYPES],
        attributes: {
          [REWRITE_BLOCK_ATTR]: {
            default: null,
            keepOnSplit: false,
            // Never from HTML (a pasted copy is a new paragraph), never into it.
            parseHTML: () => null,
            renderHTML: () => ({}),
          },
        },
      },
    ]
  },

  addKeyboardShortcuts() {
    if (this.options.detached) return {} as Record<string, () => boolean>
    return { [REWRITE_SHORTCUT]: () => reWriteShortcut?.() ?? false }
  },

  addProseMirrorPlugins() {
    return this.options.detached ? [] : [createAnchorPlugin()]
  },
})

/** Transaction setting (or clearing, with null) the anchor on every top-level block in [from, to). */
export function setAnchor(tr: Transaction, from: number, to: number, anchor: string | null): Transaction {
  tr.doc.nodesBetween(from, to, (node, pos) => {
    if (pos < from) return true
    if ((ANCHOR_TYPES as readonly string[]).includes(node.type.name) && node.attrs[REWRITE_BLOCK_ATTR] !== anchor) {
      tr.setNodeAttribute(pos, REWRITE_BLOCK_ATTR, anchor)
    }
    return false
  })
  return tr.setMeta(REWRITE_ALLOW_META, true).setMeta(TRACK_SKIP_META, true).setMeta('addToHistory', false)
}
