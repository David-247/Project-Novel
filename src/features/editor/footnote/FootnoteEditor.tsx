import type { Editor } from '@tiptap/core'
import { baseKeymap, toggleMark } from '@tiptap/pm/commands'
import { closeHistory, redo, undo } from '@tiptap/pm/history'
import { keymap } from '@tiptap/pm/keymap'
import { Fragment, Slice, type Node as PMNode, type Schema } from '@tiptap/pm/model'
import { EditorState, TextSelection, type Transaction } from '@tiptap/pm/state'
import { StepMap } from '@tiptap/pm/transform'
import { EditorView } from '@tiptap/pm/view'
import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { filterPastedComments } from '@/features/comments'
import { useStore } from '@/shared/store'
import { Button, cn, fieldBase, Tooltip } from '@/shared/ui'
import { COMPOSITION_FLUSH_MS, flushComposedText, isTracking, skipDeleted } from '@/features/track-changes'
import { COMPOSING_META } from '@/shared/track-changes'
import { useMountedEditor } from '../use-mounted-editor'
import { FOOTNOTE_EDITOR_CONTROLS } from './controls'
import { closeFootnoteEditor, useFootnoteEditing } from './editing'
import { FOOTNOTE_NODE, footnotesOf } from './numbering'

const FROM_OUTSIDE = 'nvFootnoteFromOutside'

let active: EditorView | null = null
/** Internal (tests): the nested view of the open footnote editor. */
export const activeFootnoteView = () => active
/** Gap between the reference line and the editor (px). */
const GAP = 8
const GUTTER = 8

/**
 * The footnote editor: an anchored popover under the reference holding a nested ProseMirror view
 * whose document is the footnote node itself (the ProseMirror footnote example's technique, mounted
 * in a popover instead of inline). Every change is forwarded to the manuscript's view as steps
 * mapped into the footnote, so the manuscript stays the only source of truth and undo is unified:
 * Mod-z in the note undoes in the manuscript (and the note follows). Escape, Enter or Done puts the
 * caret right after the reference; moving focus elsewhere just closes the editor. Tab and Shift-Tab
 * cycle between the note and Done. A document load (open, recent, new, recovery) closes it.
 * Decision record: docs/pagination.md, "Footnotes".
 */
export function FootnoteEditor() {
  const editing = useFootnoteEditing()
  const editor = useMountedEditor()
  if (!editing || !editor || editor.isDestroyed) return null
  return createPortal(<FootnotePopover key={editing.seq} outer={editor} pos={editing.pos} />, document.body)
}

/** Pasted blocks become one run of text: paragraphs joined by a space (a note is one paragraph). */
export function flattenPasted(slice: Slice, schema: Schema): Slice {
  let blocks = false
  slice.content.forEach((n) => {
    if (n.isBlock) blocks = true
  })
  if (!blocks) return slice
  const parts: PMNode[] = []
  slice.content.descendants((n) => {
    if (!n.isTextblock) return true
    if (parts.length && n.content.size) parts.push(schema.text(' '))
    n.forEach((c) => {
      if (c.isText) parts.push(c)
    })
    return false
  })
  return new Slice(Fragment.from(parts), 0, 0)
}

function FootnotePopover({ outer, pos: initialPos }: { outer: Editor; pos: number }) {
  const rootRef = useRef<HTMLDivElement>(null)
  const mountRef = useRef<HTMLDivElement>(null)
  const posRef = useRef(initialPos)
  const [label, setLabel] = useState(() => labelAt(outer, initialPos))
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null)

  // Return to the reference: caret right after it, in the manuscript.
  const back = useCallback(() => {
    closeFootnoteEditor()
    const view = outer.view
    const node = view.state.doc.nodeAt(posRef.current)
    if (node?.type.name === FOOTNOTE_NODE) {
      const after = posRef.current + node.nodeSize
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, after)).scrollIntoView())
    }
    view.focus()
  }, [outer])

  // Stay anchored under the reference (it moves on scroll, resize, zoom, reflow and edits).
  const reposition = useCallback(() => {
    const root = rootRef.current
    const ref = outer.isDestroyed ? null : (outer.view.nodeDOM(posRef.current) as HTMLElement | null)
    if (!root || !ref?.getBoundingClientRect) return
    const r = ref.getBoundingClientRect()
    const w = root.offsetWidth
    const h = root.offsetHeight
    const vw = window.innerWidth
    const vh = window.innerHeight
    const left = Math.round(Math.min(Math.max(GUTTER, r.left - 24), Math.max(GUTTER, vw - w - GUTTER)))
    let top = r.bottom + GAP
    if (top + h > vh - GUTTER && r.top - GAP - h >= GUTTER) top = r.top - GAP - h
    top = Math.round(top)
    setPlace((p) => (p && p.left === left && p.top === top ? p : { left, top }))
  }, [outer])

  useLayoutEffect(() => {
    const mount = mountRef.current
    const node = outer.state.doc.nodeAt(posRef.current)
    if (!mount || node?.type.name !== FOOTNOTE_NODE) {
      closeFootnoteEditor()
      return
    }
    const schema = outer.schema
    const outerView = outer.view
    const mark = (name: string) => (schema.marks[name] ? toggleMark(schema.marks[name]) : () => false)
    // The first forwarded edit starts its own undo step (not merged with the insertion of the note).
    let first = true
    const inner: EditorView = new EditorView(
      { mount },
      {
        state: EditorState.create({
          doc: node,
          plugins: [
            keymap({
              'Mod-z': () => undo(outerView.state, outerView.dispatch),
              'Mod-Shift-z': () => redo(outerView.state, outerView.dispatch),
              'Mod-y': () => redo(outerView.state, outerView.dispatch),
              'Mod-b': mark('bold'),
              'Mod-i': mark('italic'),
              'Mod-u': mark('underline'),
              Escape: () => (back(), true),
              Enter: () => (back(), true),
              // Track changes: deleted text stays in the note; Backspace / Delete go past it first (as
              // in the manuscript), so they act on text that is still there.
              Backspace: skipKey(-1),
              Delete: skipKey(1),
            }),
            keymap(baseKeymap),
          ],
        }),
        attributes: {
          role: 'textbox',
          'aria-multiline': 'false',
          'aria-label': 'Footnote text',
          spellcheck: 'true',
          'data-testid': 'footnote-editor',
          class: cn(fieldBase, 'nv-fn-editor block w-full whitespace-pre-wrap break-words py-1.5 text-ui'),
        },
        // The pasted text lands in the manuscript: the comment paste rule applies against the manuscript
        // (a copy of commented text does not duplicate the thread; after a cut the paste moves it).
        transformPasted: (slice, view) =>
          filterPastedComments(flattenPasted(slice, schema), outerView.state, !!(view as unknown as { dragging?: { move?: boolean } }).dragging?.move),
        handleDOMEvents: {
          // Track changes: what was composed in the note is marked as inserted once the composition ends.
          compositionend: () => {
            setTimeout(() => flushComposedText(outerView), COMPOSITION_FLUSH_MS)
            return false
          },
        },
        clipboardTextParser: (text) => {
          const t = text.replace(/\s*[\r\n]+\s*/g, ' ').trim()
          return t ? new Slice(Fragment.from(schema.text(t)), 0, 0) : Slice.empty
        },
        dispatchTransaction(tr: Transaction) {
          const before = inner.state.doc
          const { state, transactions } = inner.state.applyTransaction(tr)
          if (tr.getMeta(FROM_OUTSIDE) || !transactions.some((t) => t.docChanged)) {
            inner.updateState(state)
            return
          }
          // The manuscript must still hold this very note where we think it is (a document load or a
          // change we missed would send the steps into other text): otherwise close, change nothing.
          const target = outerView.state.doc.nodeAt(posRef.current)
          // While composing, a difference in marks only is expected (see mirror): the text must match.
          if (target?.type.name !== FOOTNOTE_NODE || !(inner.composing ? sameText(target, before) : target.content.eq(before.content))) {
            closeFootnoteEditor()
            return
          }
          const outerTr = outerView.state.tr
          const offset = StepMap.offset(posRef.current + 1)
          try {
            for (const t of transactions)
              for (const step of t.steps) {
                const mapped = step.map(offset)
                if (!mapped) throw new Error('footnote step did not map')
                outerTr.step(mapped)
              }
          } catch (err) {
            console.error('[footnote] edit not applied', err)
            closeFootnoteEditor()
            return
          }
          inner.updateState(state)
          if (first) {
            closeHistory(outerTr)
            first = false
          }
          // An IME composition in the note: the recorder leaves the composed text unmarked until it ends
          // (re-wrapping the composing text node cancels or doubles the composition in Safari), and
          // the composition's id keeps its steps (and the marking after it) in one undo step.
          const composition = transactions.find((t) => t.getMeta('composition') !== undefined)?.getMeta('composition')
          if (composition !== undefined) outerTr.setMeta('composition', `footnote:${String(composition)}`)
          if (inner.composing) outerTr.setMeta(COMPOSING_META, true)
          if (outerTr.docChanged) outerView.dispatch(outerTr)
          // The manuscript may have kept what the note removed (Track Changes keeps deleted text, and
          // deleting already-deleted text changes nothing there): mirror it back whenever the two differ.
          const now = outerView.state.doc.nodeAt(posRef.current)
          if (now?.type.name === FOOTNOTE_NODE) mirror(now)
        },
      },
    )
    active = inner

    /**
     * Mirror the manuscript's note into the note editor. While the note is composing, a difference in
     * marks only waits for the composition's end (re-rendering the composing text would break it);
     * a text difference is mirrored at once (the steps must keep mapping 1:1).
     */
    const mirror = (now: PMNode) => {
      if (now.content.eq(inner.state.doc.content)) return
      if (inner.composing && sameText(now, inner.state.doc)) return
      syncInner(inner, now)
    }
    // Follow the manuscript: map the footnote's position; mirror outside changes (undo, redo).
    const onTransaction = ({ transaction }: { transaction: Transaction }) => {
      if (transaction.docChanged) {
        const r = transaction.mapping.mapResult(posRef.current, 1)
        posRef.current = r.pos
        const now = outerView.state.doc.nodeAt(r.pos)
        if (r.deleted || now?.type.name !== FOOTNOTE_NODE) {
          // The footnote is gone (undo of its insertion, deleted from elsewhere).
          closeFootnoteEditor()
          if (inner.hasFocus()) outerView.focus()
          return
        }
        mirror(now)
      }
      setLabel(labelAt(outer, posRef.current))
      requestAnimationFrame(reposition)
    }
    outer.on('transaction', onTransaction)
    inner.focus()
    // Caret at the end of the note.
    inner.dispatch(inner.state.tr.setSelection(TextSelection.atEnd(inner.state.doc)).setMeta(FROM_OUTSIDE, true))

    // Placement: now, and when anything that moves the reference happens.
    reposition()
    const onMove = () => reposition()
    window.addEventListener('scroll', onMove, true)
    window.addEventListener('resize', onMove)
    const unstore = useStore.subscribe((s, p) => {
      if (s.layout !== p.layout) requestAnimationFrame(reposition)
    })
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(onMove) : null
    if (rootRef.current) ro?.observe(rootRef.current)
    return () => {
      window.removeEventListener('scroll', onMove, true)
      window.removeEventListener('resize', onMove)
      unstore()
      ro?.disconnect()
      outer.off('transaction', onTransaction)
      // Closed mid-composition (Escape, Done, blur, a failed forward): the note's compositionend
      // handler goes with the view, so mark what was composed now (in its own undo step).
      flushComposedText(outerView, { force: true })
      inner.destroy()
      if (active === inner) active = null
    }
  }, [outer, back, reposition])

  // Tab / Shift-Tab cycle between the note and Done (the popover is portalled: never tab out of it).
  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.defaultPrevented) return
    // During an IME composition, Escape cancels the candidate and Tab may pick one: the keys belong to
    // the IME, not to the popover (keyCode 229: engines that report composition keys that way).
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
    if (e.key === 'Escape') {
      e.preventDefault()
      back()
      return
    }
    if (e.key !== 'Tab') return
    e.preventDefault()
    const field = active?.dom as HTMLElement | undefined
    const done = rootRef.current?.querySelector<HTMLElement>(`[data-control-id="${FOOTNOTE_EDITOR_CONTROLS.done.id}"]`)
    const order = [field, done].filter(Boolean) as HTMLElement[]
    const i = order.indexOf(document.activeElement as HTMLElement)
    const next = order[(i + (e.shiftKey ? -1 : 1) + order.length) % order.length]
    next?.focus()
  }

  return (
    <div
      ref={rootRef}
      role="group"
      aria-label={`Footnote ${label}`}
      data-testid="footnote-popover"
      className="fixed z-40 w-[min(28rem,calc(100vw-1rem))] rounded-panel border border-border bg-surface-raised p-3 text-text shadow-raised"
      // Until it is placed: invisible but focusable (visibility: hidden would refuse focus).
      style={place ? { left: place.left, top: place.top } : { left: GUTTER, top: GUTTER, opacity: 0 }}
      // A press anywhere but the note field keeps the focus where it is (WebKit blurs to nothing on a
      // press on a button, and the popover would close before the click lands; see 143225f).
      onMouseDown={(e) => {
        if (!mountRef.current?.contains(e.target as Node)) e.preventDefault()
      }}
      onKeyDown={onKeyDown}
      onBlur={(e) => {
        const next = e.relatedTarget as Node | null
        // Focus left the editor for something else (the manuscript, the toolbar): close.
        if (next && rootRef.current?.contains(next)) return
        requestAnimationFrame(() => {
          if (rootRef.current && !rootRef.current.contains(document.activeElement)) closeFootnoteEditor()
        })
      }}
    >
      <div className="mb-2 flex items-center gap-2">
        <span className="text-ui-sm font-semibold">Footnote {label}</span>
        <span className="flex-1 text-ui-xs text-text-muted">Esc returns to the text</span>
        <Tooltip controlId={FOOTNOTE_EDITOR_CONTROLS.done.id}>
          <Button data-control-id={FOOTNOTE_EDITOR_CONTROLS.done.id} onClick={back}>
            {FOOTNOTE_EDITOR_CONTROLS.done.label}
          </Button>
        </Tooltip>
      </div>
      <div ref={mountRef} />
    </div>
  )
}

/** Backspace (-1) / Delete (+1) in the note while tracking: move past deleted text, then let the key act. */
function skipKey(dir: -1 | 1) {
  return (state: EditorState, dispatch?: (tr: Transaction) => void) => {
    if (!isTracking()) return false
    const pos = skipDeleted(state, dir)
    if (pos !== null && dispatch) dispatch(state.tr.setSelection(TextSelection.create(state.doc, pos)))
    return false
  }
}

function labelAt(editor: Editor, pos: number): string {
  return footnotesOf(editor.state).find((r) => r.pos === pos)?.label ?? ''
}

/** Same text (and size) in two notes, whatever their marks. */
function sameText(a: PMNode, b: PMNode): boolean {
  return a.content.size === b.content.size && a.textContent === b.textContent
}

/** Mirror a change made outside the note editor (undo/redo in the manuscript) into it. */
function syncInner(inner: EditorView, node: PMNode) {
  const state = inner.state
  const start = node.content.findDiffStart(state.doc.content)
  if (start == null) return
  let { a: endA, b: endB } = node.content.findDiffEnd(state.doc.content)!
  const overlap = start - Math.min(endA, endB)
  if (overlap > 0) {
    endA += overlap
    endB += overlap
  }
  inner.dispatch(state.tr.replace(start, endB, node.slice(start, endA)).setMeta(FROM_OUTSIDE, true))
}
