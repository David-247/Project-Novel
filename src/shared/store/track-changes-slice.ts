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
  }
  trackChangesActions: {
    setMarkupView: (view: MarkupView) => void
  }
}

export const createTrackChangesSlice: SliceCreator<TrackChangesSlice> = (set) => ({
  trackChanges: { markupView: 'all' },
  trackChangesActions: {
    setMarkupView: (markupView) =>
      set((s) => (s.trackChanges.markupView === markupView ? s : { trackChanges: { ...s.trackChanges, markupView } })),
  },
})
