import type { Node as PMNode } from '@tiptap/pm/model'
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { chapterRoleSignature, footnoteLabel, resolveFootnoteOptions, type FootnoteOptions } from '@/shared/book'
import { useStore } from '@/shared/store'
import { chapterIndexAt, getChapters } from '../breaks/chapters'
import { resolveStyles } from '../styles/resolved'
import { FOOTNOTE_NODE } from './name'

export { FOOTNOTE_NODE }

/**
 * A footnote reference in the document, with its derived number. Numbers are never stored: they
 * follow from document order, the chapters and `book.footnotes` (numbering scope and format).
 */
export interface FootnoteRef {
  /** Position of the footnote node (just before it). */
  pos: number
  /** The footnote node; its content is the note text. */
  node: PMNode
  /** 0-based position among all footnotes of the document. */
  ordinal: number
  /** 1-based number within its scope (the book, or its chapter). */
  number: number
  /** Rendered mark: "3", or "†". */
  label: string
  /** Chapter of the reference (-1: front matter). */
  chapter: number
}

interface NumberingState {
  refs: readonly FootnoteRef[]
  set: DecorationSet
  /** Labels + options: decorations are mapped while it stays the same, rebuilt when it changes. */
  sig: string
}

export const footnoteNumberingKey = new PluginKey<NumberingState>('footnoteNumbering')

/** Per top-level block: its footnotes (position relative to the block). Blocks are immutable. */
const blockNotes = new WeakMap<PMNode, readonly { rel: number; node: PMNode }[]>()
const NONE: readonly { rel: number; node: PMNode }[] = []

function notesOf(block: PMNode): readonly { rel: number; node: PMNode }[] {
  let list = blockNotes.get(block)
  if (list) return list
  let found: { rel: number; node: PMNode }[] | null = null
  if (!block.isLeaf)
    block.descendants((n, p) => {
      if (n.type.name === FOOTNOTE_NODE) {
        ;(found ??= []).push({ rel: p + 1, node: n })
        return false
      }
      return !n.isText
    })
  list = found ?? NONE
  blockNotes.set(block, list)
  return list
}

/** Every footnote of `doc` in order, numbered per `options`. O(top-level blocks) for unchanged blocks. */
export function collectFootnotes(doc: PMNode, options: FootnoteOptions): FootnoteRef[] {
  const found: { pos: number; node: PMNode }[] = []
  doc.forEach((block, pos) => {
    for (const n of notesOf(block)) found.push({ pos: pos + n.rel, node: n.node })
  })
  if (found.length === 0) return []
  const chapters = options.numbering === 'chapter' ? getChapters(doc) : null
  let scope = Number.NaN
  let n = 0
  return found.map((f, ordinal) => {
    const chapter = chapters ? chapterIndexAt(chapters, f.pos) : -1
    if (chapters && chapter !== scope) {
      scope = chapter
      n = 0
    }
    n++
    return { pos: f.pos, node: f.node, ordinal, number: n, label: footnoteLabel(n, options.format), chapter }
  })
}

function decorate(doc: PMNode, refs: readonly FootnoteRef[]): DecorationSet {
  if (refs.length === 0) return DecorationSet.empty
  return DecorationSet.create(
    doc,
    refs.map((r) =>
      Decoration.node(r.pos, r.pos + r.node.nodeSize, { 'data-fn-num': r.label, 'aria-label': `Footnote ${r.label}` }, { nvFootnote: true }),
    ),
  )
}

const optionsNow = () => resolveFootnoteOptions(useStore.getState().book.footnotes)
const signature = (refs: readonly FootnoteRef[], o: FootnoteOptions) => `${o.numbering}|${o.format}|${refs.map((r) => r.label).join(',')}`

function compute(doc: PMNode): NumberingState {
  const options = optionsNow()
  const refs = collectFootnotes(doc, options)
  return { refs, set: decorate(doc, refs), sig: signature(refs, options) }
}

/** The footnotes of a state, numbered (empty when the numbering plugin is absent). */
export function footnotesOf(state: EditorState): readonly FootnoteRef[] {
  return footnoteNumberingKey.getState(state)?.refs ?? []
}

export type FootnotesListener = (refs: readonly FootnoteRef[], previous: readonly FootnoteRef[]) => void
const listeners = new Set<FootnotesListener>()

/**
 * Called after every view update that changed the footnote list (an edit moved, added, removed or
 * renumbered a footnote, or changed a note's text). Returns unsubscribe.
 */
export function onFootnotesChange(cb: FootnotesListener): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

/**
 * Derived numbering: the plugin keeps the numbered footnote list and draws each reference's mark as
 * a node decoration (`data-fn-num`, shown by CSS). Recomputed on document changes (unchanged blocks
 * are cached) and when `book.footnotes` changes.
 */
export function footnoteNumberingPlugin(): Plugin<NumberingState> {
  return new Plugin<NumberingState>({
    key: footnoteNumberingKey,
    state: {
      init: (_, state) => compute(state.doc),
      apply: (tr, prev) => {
        const renumber = tr.getMeta(footnoteNumberingKey) === true
        if (!tr.docChanged && !renumber) return prev
        const options = optionsNow()
        const refs = collectFootnotes(tr.doc, options)
        if (refs.length === 0 && prev.refs.length === 0) return prev
        const sig = signature(refs, options)
        if (sig === prev.sig && !renumber) {
          const set = prev.set.map(tr.mapping, tr.doc)
          // A note cut and pasted elsewhere keeps the labels but loses its mapped decoration.
          if (set.find().length === refs.length) return { refs, set, sig }
        }
        return { refs, set: decorate(tr.doc, refs), sig }
      },
    },
    props: {
      decorations: (state) => footnoteNumberingKey.getState(state)?.set,
    },
    view: (view) => {
      let prevOptions = useStore.getState().book.footnotes
      let prevStyles = useStore.getState().book.styles
      let prevRoles = chapterRoleSignature(resolveStyles(prevStyles))
      const unsub = useStore.subscribe((s) => {
        let renumber = false
        if (s.book.footnotes !== prevOptions) {
          prevOptions = s.book.footnotes
          renumber = true
        }
        // Which styles open a chapter is part of the style sheet: per-chapter numbers follow it.
        if (s.book.styles !== prevStyles) {
          prevStyles = s.book.styles
          const roles = chapterRoleSignature(resolveStyles(prevStyles))
          if (roles !== prevRoles) {
            prevRoles = roles
            if (resolveFootnoteOptions(s.book.footnotes).numbering === 'chapter') renumber = true
          }
        }
        if (renumber && !view.isDestroyed) view.dispatch(view.state.tr.setMeta(footnoteNumberingKey, true).setMeta('addToHistory', false))
      })
      return {
        update: (v, prevState) => {
          const a = footnoteNumberingKey.getState(prevState)?.refs ?? []
          const b = footnoteNumberingKey.getState(v.state)?.refs ?? []
          if (a !== b) listeners.forEach((l) => l(b, a))
        },
        destroy: () => {
          unsub()
          const last = footnoteNumberingKey.getState(view.state)?.refs ?? []
          if (last.length) listeners.forEach((l) => l([], last))
        },
      }
    },
  })
}
