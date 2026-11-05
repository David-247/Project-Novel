import type { MarkupView } from '@/shared/track-changes'
import type { SliceCreator } from './types'

/**
 * Track changes UI state. Whether changes are recorded is a per-project book setting
 * (`book.trackChanges`, bookActions.setTrackChanges); the markup view is UI state, not saved with
 * the project.
 */
export interface TrackChangesSlice {
  trackChanges: {
    /** View ▸ Markup: what the pages show of the tracked changes. */
    markupView: MarkupView
    /** A warning for the status bar (an edit that could not be recorded), or null. */
    notice: string | null
  }
  trackChangesActions: {
    setMarkupView: (view: MarkupView) => void
    setNotice: (notice: string | null) => void
  }
}

export const createTrackChangesSlice: SliceCreator<TrackChangesSlice> = (set) => ({
  trackChanges: { markupView: 'all', notice: null },
  trackChangesActions: {
    setMarkupView: (markupView) =>
      set((s) => (s.trackChanges.markupView === markupView ? s : { trackChanges: { ...s.trackChanges, markupView } })),
    setNotice: (notice) => set((s) => (s.trackChanges.notice === notice ? s : { trackChanges: { ...s.trackChanges, notice } })),
  },
})
