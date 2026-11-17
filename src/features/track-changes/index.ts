// Public interface of the "track-changes" slice (docs/track-changes.md). Other slices import ONLY from
// here. Shared names and the view rules (mark names, MarkupView, isInlineHidden / isBlockHidden) are in
// @/shared/track-changes.
//
// Schema + recording: `TrackChanges` (in the editor's extension list) adds the insertion, deletion and
// formatChange marks, the trackedInsert / trackedDelete / trackedStyleChange block attributes, the
// recorder (dispatch hook), Mod-Shift-e and the markup view decorations. Option `getAuthor` (default
// `currentTrackAuthor`: the source set by setTrackChangesAuthorSource, else "Unknown author") is the author of new changes.
// Commands: toggleTrackChanges(editor?), setTracking(on), isTracking(state?), setMarkupView(view),
// getMarkupView(state?), countChanges(editorState), listChanges(doc).
// Accept / reject core (pure, return a Transaction or null): acceptChange, rejectChange, acceptAll,
// rejectAll, acceptChangesInRange, rejectChangesInRange.
// Pagination: setMarkupViewRepaginate(invalidatePaginationAt) in the composition root.
// UI: TrackChangesButton (`review.track`) and MarkupViewMenu (`review.markup`), wrap in ToolbarItem.
// Integration: registerTrackChangesCommands() (Review > Track Changes, View > Markup ▸; command
// registry), setTrackChangesAuthorSource(fn) (author of new changes), setOnTrackingSwitchedOn(fn)
// (called when the user switches recording on: the one-time author-name question).
// Tests import the slice's internals by path (./review, ./record...), never through this index.
export { TrackChanges, setTrackChangesAuthorSource, currentTrackAuthor, setMarkupViewRepaginate, skipDeleted, TRACK_FAILED_NOTICE, flushComposedText, COMPOSITION_FLUSH_MS } from './extension'
export type { TrackChangesOptions } from './extension'
export { trackTransaction, TRACK_SKIP_META, TRACKED_META, TRACK_FAILED_META } from './record'
export type { TrackOptions } from './record'
export type { Author, ChangeStamp, StyleChangeStamp } from './record'
export {
  acceptChange,
  rejectChange,
  acceptAll,
  rejectAll,
  acceptChangesInRange,
  rejectChangesInRange,
  listChanges,
  countChanges,
  acceptAllByAuthor,
  rejectAllByAuthor,
  listAuthors,
  changeIdAt,
} from './review'
export type { TrackedChange, ChangeKind } from './review'
// Review UI (docs/track-changes.md, "Review"): commands as plain functions, the change popover and
// the status-bar count; setReviewConfirm (Accept / Reject All above 50 changes) and
// setChangeRevealer (how a change is brought into sight; default: the pagination slice's revealPosition, which turns
// the page in Book mode) are wired by the root, as is
// setReviewViewSource (the manuscript view: other editors with TrackChanges are never reviewed;
// TrackChanges.configure({ review: false }) leaves the review side out of such an editor entirely).
export {
  nextChange,
  prevChange,
  resolveSelection,
  resolveAndNext,
  resolveChange,
  resolveAll,
  setReviewConfirm,
  setChangeRevealer,
  CONFIRM_ABOVE,
} from './review-actions'
export type { ReviewMode, ReviewConfirm, ReviewConfirmRequest, ChangeRevealer } from './review-actions'
export { showChangeAtCaret, relativeDate } from './popover-actions'
export { setReviewViewSource, getReviewView } from './review-state'
export { ChangePopover, ChangesIndicator } from './ReviewUI'
export { isTracking, setTracking, toggleTrackChanges, getMarkupView, setMarkupView, setOnTrackingSwitchedOn } from './commands'
export { registerTrackChangesCommands } from './menu-commands'
export { TRACK_CHANGES_CONTROLS, MARKUP_VIEW_OPTIONS, BY_AUTHOR_SUBMENU } from './controls'
export { TrackChangesButton, MarkupViewMenu, TrackChangesNotice } from './ReviewControls'
