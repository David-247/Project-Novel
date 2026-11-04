import { useSyncExternalStore } from 'react'
import { subscribeDocLoad, subscribeEditor } from '../controller'

/**
 * Which footnote's text is being edited (the anchored footnote editor, FootnoteEditor.tsx).
 * `pos` is the footnote node's position when it was opened; the editor maps it through every
 * transaction itself. `seq` changes on every open, so opening the same footnote again refocuses it.
 */
export interface FootnoteEditing {
  pos: number
  seq: number
}

let current: FootnoteEditing | null = null
let seq = 0
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

/** Open the footnote editor on the footnote node at `pos`. */
let guarded = false

export function openFootnoteEditor(pos: number): void {
  if (!guarded) {
    // A document load (open, open recent, new project, recovery restore: each replaces the editor
    // state without a transaction) or another editor instance invalidates the open note: close it,
    // so it can never send its edits into a different document. (Subscribed on first use: the
    // controller module imports this one through the extensions.)
    guarded = true
    subscribeDocLoad(closeFootnoteEditor)
    subscribeEditor(closeFootnoteEditor)
  }
  current = { pos, seq: ++seq }
  emit()
}

export function closeFootnoteEditor(): void {
  if (!current) return
  current = null
  emit()
}

export function getFootnoteEditing(): FootnoteEditing | null {
  return current
}

function subscribe(cb: () => void) {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function useFootnoteEditing(): FootnoteEditing | null {
  return useSyncExternalStore(subscribe, getFootnoteEditing, getFootnoteEditing)
}
