import type { Editor } from '@tiptap/core'
import { baseKeymap, toggleMark } from '@tiptap/pm/commands'
import { redo, undo } from '@tiptap/pm/history'
import { keymap } from '@tiptap/pm/keymap'
import type { Node as PMNode } from '@tiptap/pm/model'
import { EditorState, TextSelection, type Transaction } from '@tiptap/pm/state'
import { StepMap } from '@tiptap/pm/transform'
import { EditorView } from '@tiptap/pm/view'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Button, cn, fieldBase, Tooltip } from '@/shared/ui'
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
 * caret right after the reference; moving focus elsewhere just closes the editor.
 * Decision record: docs/pagination.md, "Footnotes".
 */
export function FootnoteEditor() {
  const editing = useFootnoteEditing()
  const editor = useMountedEditor()
  if (!editing || !editor || editor.isDestroyed) return null
  return createPortal(<FootnotePopover key={editing.seq} outer={editor} pos={editing.pos} />, document.body)
}

function FootnotePopover({ outer, pos: initialPos }: { outer: Editor; pos: number }) {
  const rootRef = useRef<HTMLDivElement>(null)
  const mountRef = useRef<HTMLDivElement>(null)
  const posRef = useRef(initialPos)
  const innerRef = useRef<EditorView | null>(null)
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
        dispatchTransaction(tr: Transaction) {
          const { state, transactions } = inner.state.applyTransaction(tr)
          inner.updateState(state)
          if (tr.getMeta(FROM_OUTSIDE)) return
          const outerTr = outerView.state.tr
          const offset = StepMap.offset(posRef.current + 1)
          for (const t of transactions) for (const step of t.steps) {
            const mapped = step.map(offset)
            if (mapped) outerTr.step(mapped)
          }
          if (outerTr.docChanged) outerView.dispatch(outerTr)
        },
      },
    )
    innerRef.current = inner
    active = inner

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
        syncInner(inner, now)
      }
      setLabel(labelAt(outer, posRef.current))
    }
    outer.on('transaction', onTransaction)
    inner.focus()
    // Caret at the end of the note.
    inner.dispatch(inner.state.tr.setSelection(TextSelection.atEnd(inner.state.doc)).setMeta(FROM_OUTSIDE, true))
    return () => {
      outer.off('transaction', onTransaction)
      inner.destroy()
      innerRef.current = null
      if (active === inner) active = null
    }
  }, [outer, back])

  // Stay anchored under the reference (pages move on scroll, zoom and reflow).
  useEffect(() => {
    let frame = 0
    const tick = () => {
      frame = requestAnimationFrame(tick)
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
    }
    tick()
    return () => cancelAnimationFrame(frame)
  }, [outer])

  return (
    <div
      ref={rootRef}
      role="group"
      aria-label={`Footnote ${label}`}
      data-testid="footnote-popover"
      className="fixed z-40 w-[min(28rem,calc(100vw-1rem))] rounded-panel border border-border bg-surface-raised p-3 text-text shadow-raised"
      // Until it is placed: invisible but focusable (visibility: hidden would refuse focus).
      style={place ? { left: place.left, top: place.top } : { left: GUTTER, top: GUTTER, opacity: 0 }}
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

function labelAt(editor: Editor, pos: number): string {
  return footnotesOf(editor.state).find((r) => r.pos === pos)?.label ?? ''
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
