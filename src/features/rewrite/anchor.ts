import { Extension } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state'
import type { Step } from '@tiptap/pm/transform'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'
import { TRACK_SKIP_META } from '@/features/track-changes'
import { BULK_EDIT_META, REWRITE_BLOCK_ATTR } from '@/shared/rewrite'
import { useStore } from '@/shared/store'

/**
 * The re-write anchor in the manuscript (docs/project-format.md, "rewrites.json"):
 *
 * - `rewriteId`, a block attribute on the top-level block types. Set with setNodeMarkup only (never
 *   AttrStep), outside the undo history, with TRACK_SKIP_META (never a tracked change). Not parsed
 *   from HTML and not rendered, so a copy pasted elsewhere never carries it; not kept on split.
 * - The lock: while a re-write is open (status 'open'), its passage (the run of top-level blocks
 *   carrying its anchor) is read-only. A filterTransaction refuses edits inside it, a beforeinput
 *   handler stops the browser from typing there, and the refusal raises a notice that offers to open
 *   the re-write. Programmatic edits pass: Replace All (BULK_EDIT_META), accept / reject
 *   (TRACK_SKIP_META), undo / redo, and the re-write's own writes (REWRITE_ALLOW_META); when one of
 *   the first three changes the passage, the re-write is marked "original changed".
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

interface AnchorState {
  ranges: readonly LockedRange[]
  decorations: DecorationSet
}

export const rewriteAnchorKey = new PluginKey<AnchorState>('nvRewriteAnchor')

/** Anchor ids of the re-writes that lock their passage (status 'open'). */
function openAnchors(): ReadonlySet<string> {
  const set = new Set<string>()
  for (const r of useStore.getState().rewrite.rewrites) if (r.status === 'open') set.add(r.anchor)
  return set
}

const anchorSignature = () => [...openAnchors()].sort().join(' ')

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

/** The passage of `anchor`: from its first block to its last one, or null when no block carries it. */
export function passageRange(doc: PMNode, anchor: string): { from: number; to: number } | null {
  const runs = passageRanges(doc, anchor)
  return runs.length ? { from: runs[0].from, to: runs[runs.length - 1].to } : null
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

/** [from, to] touched by a step in the doc it applies to, or null (a step that changes no content range). */
function stepRange(step: Step): [number, number] | null {
  const s = step as unknown as { from?: unknown; to?: unknown; pos?: unknown }
  if (typeof s.from === 'number' && typeof s.to === 'number') return [s.from, s.to]
  if (typeof s.pos === 'number') return [s.pos, s.pos + 1]
  return null
}

/** The first locked range a transaction's steps touch (inside it, not just at its outer edge), or null. */
export function touchedRange(tr: Transaction, ranges: readonly LockedRange[]): LockedRange | null {
  if (!ranges.length) return null
  let current = ranges.map((r) => [r.from, r.to] as [number, number])
  for (const step of tr.steps) {
    const span = stepRange(step)
    if (span) {
      const [a, b] = span
      for (let i = 0; i < current.length; i++) {
        const [f, t] = current[i]
        if (t <= f) continue
        if (a === b ? a > f && a < t : a < t && b > f) return ranges[i]
      }
    }
    const map = step.getMap()
    current = current.map(([f, t]) => [map.map(f, 1), map.map(t, -1)])
  }
  return null
}

let seq = 0
/** The user tried to edit the locked passage of `id`: the manuscript's notice offers to open it. */
function refused(id: string) {
  useStore.getState().rewriteActions.setNotice({ kind: 'locked', id, seq: ++seq })
}

/** Called (once per transaction) with the anchors whose passage a programmatic edit changed. */
let onOriginalChanged: ((anchor: string) => void) | null = null
export function setOriginalChangedHandler(fn: ((anchor: string) => void) | null): void {
  onOriginalChanged = fn
}

let onSideBarClick: ((anchor: string) => void) | null = null
/** A click on a locked passage's side bar (the left margin beside it): reopen its re-write. */
export function setSideBarClickHandler(fn: ((anchor: string) => void) | null): void {
  onSideBarClick = fn
}

function programmatic(tr: Transaction): boolean {
  return tr.getMeta(BULK_EDIT_META) === true || tr.getMeta(TRACK_SKIP_META) === true || !!tr.getMeta('history$')
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
        return { ranges, decorations: buildDecorations(state.doc, ranges) }
      },
      apply(tr, value, _old, state) {
        if (!tr.docChanged && !tr.getMeta(REFRESH_META)) return value
        // O(top-level blocks) per edit, attribute reads only: microseconds on a 100k-word manuscript.
        const ranges = computeRanges(state.doc, openAnchors())
        if (sameRanges(ranges, value.ranges)) {
          return tr.docChanged ? { ranges: value.ranges, decorations: value.decorations.map(tr.mapping, tr.doc) } : value
        }
        return { ranges, decorations: buildDecorations(state.doc, ranges) }
      },
    },
    filterTransaction(tr, state) {
      if (!tr.docChanged || tr.getMeta(REWRITE_ALLOW_META)) return true
      const ranges = rewriteAnchorKey.getState(state)?.ranges
      if (!ranges?.length) return true
      const hit = touchedRange(tr, ranges)
      if (!hit) return true
      if (programmatic(tr)) {
        const anchor = hit.id
        queueMicrotask(() => onOriginalChanged?.(anchor))
        return true
      }
      refused(hit.id)
      return false
    },
    props: {
      decorations: (state) => rewriteAnchorKey.getState(state)?.decorations,
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
        view.dispatch(view.state.tr.setMeta(REFRESH_META, {}).setMeta('addToHistory', false))
      })
      const syncCaret = (state: EditorState) => {
        const id = selectionLocked(state)?.id ?? null
        if (useStore.getState().rewrite.caretIn !== id) useStore.getState().rewriteActions.setCaretIn(id)
      }
      syncCaret(view.state)
      return {
        update(v, prevState) {
          const before = rewriteAnchorKey.getState(prevState)
          const now = rewriteAnchorKey.getState(v.state)
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
export const REWRITE_SHORTCUT = 'Mod-Alt-r'

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
      tr.setNodeMarkup(pos, undefined, { ...node.attrs, [REWRITE_BLOCK_ATTR]: anchor })
    }
    return false
  })
  return tr.setMeta(REWRITE_ALLOW_META, true).setMeta(TRACK_SKIP_META, true).setMeta('addToHistory', false)
}
