import { Extension } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import { Plugin, PluginKey, Selection, TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'
import { useStore } from '@/shared/store'
import {
  currentMarkupView,
  DELETION_MARK,
  isBlockHidden,
  MARKUP_VIEW_META,
  TRACKED_DELETE_ATTR,
  TRACKING_BLOCK_ATTRS,
  TRACKING_MARKS,
  type MarkupView,
} from '@/shared/track-changes'
import { toggleTrackChanges } from './commands'
import { copiedSlice } from './copy'
import {
  cleanSlice,
  DEFERRED_INSERT_META,
  markComposed,
  shouldTrack,
  TRACK_FAILED_META,
  TRACK_SKIP_META,
  trackTransaction,
  type Author,
} from './record'
import { DeletionMark, FormatChangeMark, InsertionMark, TrackedBlockAttributes } from './schema'
import './track-changes.css'

export interface TrackChangesOptions {
  /** Who is editing: the author stamped on new changes. The controller wires it to the settings. */
  getAuthor: () => Author
  /** Whether changes are recorded now. Default: the project's book setting `trackChanges`. */
  isEnabled: () => boolean
}

export const trackChangesKey = new PluginKey<DecorationSet>('nvTrackChanges')

/** Status-bar text when an edit could not be recorded (it was applied untracked, never lost). */
export const TRACK_FAILED_NOTICE = 'Track Changes could not record your last edit. It was made without tracking.'

interface TrackChangesStorage {
  /** Composed text not marked yet (positions in the current doc): marked when the IME composition ends. */
  pending: (readonly [number, number])[]
  /** ProseMirror's id of that composition (transaction meta 'composition'): keeps the marking in its undo step. */
  composition: unknown
}

// ---- Markup view on the page -------------------------------------------------------------------

/** `<html data-nv-markup>`: the CSS of every view (the manuscript, the footnote area and editor). */
export function applyMarkupViewAttribute(view: MarkupView, root: HTMLElement = document.documentElement): void {
  if (root.dataset.nvMarkup !== view) root.dataset.nvMarkup = view
}

let repaginate: ((positions: number[]) => void) | null = null
/**
 * Called after the markup view changed, with the positions of the top-level blocks that hold tracked
 * changes (their line boxes changed). The composition root passes the pagination slice's
 * `invalidatePaginationAt`. Returns the unregister function.
 */
export function setMarkupViewRepaginate(fn: ((positions: number[]) => void) | null): () => void {
  repaginate = fn
  return () => {
    if (repaginate === fn) repaginate = null
  }
}

const tracked = new WeakMap<PMNode, boolean>()
/** The node, or anything inside it, carries a tracked change. Cached per (immutable) node. */
export function hasTrackedChanges(node: PMNode): boolean {
  let v = tracked.get(node)
  if (v !== undefined) return v
  const own = (n: PMNode) => n.marks.some((m) => TRACKING_MARKS.includes(m.type.name)) || TRACKING_BLOCK_ATTRS.some((a) => n.attrs[a] != null)
  v = own(node)
  if (!v && !node.isLeaf)
    node.descendants((n) => {
      if (v) return false
      if (own(n)) v = true
      return !v
    })
  tracked.set(node, v)
  return v
}

/** Positions of the top-level blocks holding tracked changes. O(top-level blocks) once cached. */
export function changedBlockPositions(doc: PMNode): number[] {
  const out: number[] = []
  doc.forEach((node, pos) => {
    if (hasTrackedChanges(node)) out.push(pos)
  })
  return out
}

// ---- Hidden-block decorations --------------------------------------------------------------------

function decoFor(node: PMNode, pos: number): Decoration | null {
  const classes: string[] = []
  if (isBlockHidden(node, 'none')) classes.push('nv-tc-gone-final')
  if (isBlockHidden(node, 'original')) classes.push('nv-tc-gone-original')
  if (node.isTextblock) {
    let del = false
    node.forEach((c) => {
      if (!del && c.marks.some((m) => m.type.name === DELETION_MARK)) del = true
    })
    if (del) classes.push('nv-tc-has-del')
  }
  return classes.length ? Decoration.node(pos, pos + node.nodeSize, { class: classes.join(' ') }, { nvTc: true }) : null
}

const isUnit = (n: PMNode) => n.isTextblock || (n.isBlock && n.isLeaf)

function computeDecos(doc: PMNode): DecorationSet {
  const decos: Decoration[] = []
  doc.descendants((node, pos) => {
    if (node.isInline) return false
    if (isUnit(node)) {
      const d = hasTrackedChanges(node) ? decoFor(node, pos) : null
      if (d) decos.push(d)
      return false
    }
    return hasTrackedChanges(node)
  })
  return DecorationSet.create(doc, decos)
}

/** Above this many steps a transaction recomputes the decorations instead of patching them. */
const INCREMENTAL_MAX_STEPS = 16

function updateDecos(tr: Transaction, set: DecorationSet): DecorationSet {
  if (tr.steps.length > INCREMENTAL_MAX_STEPS) return computeDecos(tr.doc)
  let next = set.map(tr.mapping, tr.doc)
  const size = tr.doc.content.size
  tr.mapping.maps.forEach((map, i) => {
    const rest = tr.mapping.slice(i + 1)
    map.forEach((_a, _b, from, to) => {
      const a = Math.max(0, Math.min(size, rest.map(from, -1)))
      const b = Math.max(a, Math.min(size, rest.map(to, 1)))
      tr.doc.nodesBetween(a, b, (node, pos) => {
        if (node.isInline) return false
        if (!isUnit(node)) return true
        const old = next.find(pos, pos + node.nodeSize, (spec) => (spec as { nvTc?: boolean }).nvTc === true).filter((d) => d.from === pos)
        if (old.length) next = next.remove(old)
        const d = decoFor(node, pos)
        if (d) next = next.add(tr.doc, [d])
        return false
      })
    })
  })
  return next
}

// ---- Keys ----------------------------------------------------------------------------------------

const deleted = (n: PMNode | null | undefined) => !!n && n.isInline && n.marks.some((m) => m.type.name === DELETION_MARK)

/**
 * Where Backspace (dir -1) or Delete (+1) should start so that it goes past text (and paragraph
 * boundaries) that are already deleted, or null when the caret is fine where it is.
 */
export function skipDeleted(state: EditorState, dir: -1 | 1): number | null {
  const sel = state.selection
  if (!(sel instanceof TextSelection) || !sel.empty) return null
  const doc = state.doc
  let pos = sel.head
  for (let guard = 0; guard < 10_000; guard++) {
    const $p = doc.resolve(pos)
    const n = dir < 0 ? $p.nodeBefore : $p.nodeAfter
    if (deleted(n)) {
      pos += dir * n!.nodeSize
      continue
    }
    if (!n && $p.parent.isTextblock && $p.depth > 0) {
      if (dir < 0 && $p.parent.attrs[TRACKED_DELETE_ATTR]) {
        const prev = Selection.findFrom(doc.resolve($p.before()), -1, true)
        if (prev && prev.head < pos) {
          pos = prev.head
          continue
        }
      }
      if (dir > 0) {
        const next = doc.resolve($p.after()).nodeAfter
        if (next?.isTextblock && next.attrs[TRACKED_DELETE_ATTR]) {
          pos = $p.after() + 1
          continue
        }
      }
    }
    break
  }
  return pos === sel.head ? null : pos
}

/**
 * Track changes: the marks and block attributes, the recorder (a dispatch hook: the user's
 * transaction is replaced by its tracked form, so one edit stays one undo step), Mod-Shift-e,
 * Backspace / Delete past deleted text, final-text copy, and the hidden-block decorations of the
 * markup views. See docs/track-changes.md.
 */
export const TrackChanges = Extension.create<TrackChangesOptions, TrackChangesStorage>({
  name: 'trackChanges',
  // Before the core keymap (Backspace / Delete) and TextAlign (whose Mod-Shift-e moved to Mod-e).
  priority: 1200,

  addOptions() {
    return {
      getAuthor: () => ({ name: 'Author' }),
      isEnabled: () => useStore.getState().book.trackChanges === true,
    }
  },

  addExtensions: () => [InsertionMark, DeletionMark, FormatChangeMark, TrackedBlockAttributes],

  addStorage: () => ({ pending: [], composition: undefined }),

  dispatchTransaction({ transaction, next }) {
    const storage = this.storage
    const view = this.editor.view
    const composing = !!view && view.composing
    let out = transaction
    if (shouldTrack(transaction) && this.options.isEnabled()) {
      out = trackTransaction(this.editor.state, transaction, this.options.getAuthor(), undefined, { composing, pending: storage.pending })
      if (out.getMeta(TRACK_FAILED_META)) useStore.getState().trackChangesActions.setNotice(TRACK_FAILED_NOTICE)
    }
    if (storage.pending.length && out.docChanged)
      storage.pending = storage.pending.map(([a, b]) => [out.mapping.map(a, -1), out.mapping.map(b, 1)] as const).filter(([a, b]) => b > a)
    const deferred = out.getMeta(DEFERRED_INSERT_META) as (readonly [number, number])[] | undefined
    if (deferred) {
      storage.pending = [...storage.pending, ...deferred]
      storage.composition = out.getMeta('composition')
    }
    // The composition is over: the composed text gets its insertion mark in this same transaction.
    if (!composing && storage.pending.length && !out.getMeta(TRACK_SKIP_META) && !out.getMeta('history$') && this.options.isEnabled()) {
      markComposed(out, storage.pending, this.options.getAuthor())
      storage.pending = []
    }
    next(out)
  },

  addKeyboardShortcuts() {
    const skip = (dir: -1 | 1) => () => {
      if (!this.options.isEnabled()) return false
      const pos = skipDeleted(this.editor.state, dir)
      if (pos !== null) this.editor.view.dispatch(this.editor.state.tr.setSelection(TextSelection.create(this.editor.state.doc, pos)))
      return false
    }
    return {
      'Mod-Shift-e': () => {
        toggleTrackChanges()
        return true
      },
      Backspace: skip(-1),
      Delete: skip(1),
    }
  },

  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: trackChangesKey,
        state: {
          init: (_, state) => computeDecos(state.doc),
          apply: (tr, set) => (tr.docChanged ? updateDecos(tr, set) : set),
        },
        props: {
          decorations: (state) => trackChangesKey.getState(state),
          handleDOMEvents: {
            // ProseMirror reads the composition's last DOM change right after compositionend; when it
            // has none, mark what was composed in a transaction of its own (merged into the same undo
            // step: adjacent and within the history's group delay).
            compositionend: (view) => {
              setTimeout(() => {
                const storage = this.storage
                if (view.isDestroyed || view.composing || storage.pending.length === 0) return
                const tr = view.state.tr
                markComposed(tr, storage.pending, this.options.getAuthor())
                storage.pending = []
                // Same composition id: the history keeps it in the composition's undo step.
                if (storage.composition !== undefined) tr.setMeta('composition', storage.composition)
                if (tr.docChanged) view.dispatch(tr.setMeta(TRACK_SKIP_META, true))
              }, 30)
              return false
            },
          },
          transformCopied: (slice) => copiedSlice(slice, currentMarkupView()),
          transformPasted: (slice) => cleanSlice(slice),
        },
        view: (view: EditorView) => {
          applyMarkupViewAttribute(currentMarkupView())
          const unsub = useStore.subscribe((s, prev) => {
            const v = s.trackChanges.markupView
            if (v === prev.trackChanges.markupView || view.isDestroyed) return
            applyMarkupViewAttribute(v)
            // Recompute what depends on the view (footnote numbers, breaks, find), then re-measure.
            view.dispatch(view.state.tr.setMeta(MARKUP_VIEW_META, v).setMeta('addToHistory', false))
            repaginate?.(changedBlockPositions(view.state.doc))
          })
          return { destroy: unsub }
        },
      }),
    ]
  },
})
