import type { Editor } from '@tiptap/core'
import { useStore, type RootState } from '@/shared/store'
import type { MarkupView } from '@/shared/track-changes'

/**
 * Plain commands for the command registry and menus (wired by the composition root). Recording is a
 * per-project book setting (book.json `trackChanges`); the markup view is UI state.
 */

/** Track Changes is recording (pass a store state, e.g. inside a selector; default: now). */
export const isTracking = (state: Pick<RootState, 'book'> = useStore.getState()): boolean => state.book.trackChanges === true

/** Turn recording on or off. Existing changes stay either way. */
export function setTracking(on: boolean): void {
  useStore.getState().bookActions.setTrackChanges(on)
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
