import type { Editor } from '@tiptap/core'
import { useStore, type RootState } from '@/shared/store'
import type { MarkupView } from '@/shared/track-changes'

/**
 * Plain commands for the command registry and menus (wired by the composition root). Recording is a
 * per-project book setting (book.json `trackChanges`); the markup view is UI state.
 */

/** Track Changes is recording (pass a store state, e.g. inside a selector; default: now). */
export const isTracking = (state: Pick<RootState, 'book'> = useStore.getState()): boolean => state.book.trackChanges === true

/**
 * Called when the user switches recording on (toolbar, Mod-Shift-e, the menu), not when a project
 * that records is opened. The composition root asks the one-time author-name question here: the
 * recorder cannot wait for it, so it is asked before the first change is recorded.
 */
let onTrackingSwitchedOn: (() => void) | null = null
export function setOnTrackingSwitchedOn(fn: (() => void) | null): void {
  onTrackingSwitchedOn = fn
}

/** Turn recording on or off. Existing changes stay either way. */
export function setTracking(on: boolean): void {
  const s = useStore.getState()
  const was = isTracking(s)
  s.trackChangesActions.setNotice(null)
  s.bookActions.setTrackChanges(on)
  if (on && !was) {
    try {
      onTrackingSwitchedOn?.()
    } catch (e) {
      console.warn('Switching Track Changes on:', e)
    }
  }
}

/** Flip recording (Mod-Shift-e). `editor`, when given, gets the focus back. Returns the new state. */
export function toggleTrackChanges(editor?: Editor | null): boolean {
  const on = !isTracking()
  setTracking(on)
  if (editor && !editor.isDestroyed) editor.commands.focus()
  return on
}

/** The markup view now (pass a store state inside a selector). */
export const getMarkupView = (state: Pick<RootState, 'trackChanges'> = useStore.getState()): MarkupView => state.trackChanges.markupView

/** View ▸ Markup: switches what the pages show; the pages repaginate. */
export function setMarkupView(view: MarkupView): void {
  useStore.getState().trackChangesActions.setMarkupView(view)
}
