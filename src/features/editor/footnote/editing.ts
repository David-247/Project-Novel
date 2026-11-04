import { useSyncExternalStore } from 'react'

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
export function openFootnoteEditor(pos: number): void {
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
