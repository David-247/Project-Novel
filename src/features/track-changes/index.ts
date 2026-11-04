// Public interface of the "track-changes" slice (docs/track-changes.md). Other slices import ONLY from
// here. Shared names and the view rules (mark names, MarkupView, isInlineHidden / isBlockHidden) are in
// @/shared/track-changes.
//
// Schema + recording: `TrackChanges` (in the editor's extension list) adds the insertion, deletion and
// formatChange marks, the trackedInsert / trackedDelete / trackedStyleChange block attributes, the
// recorder (dispatch hook), Mod-Shift-e and the markup view decorations. Option `getAuthor` (default
// `() => ({ name: 'Author' })`) is the author of new changes.
// Commands: toggleTrackChanges(editor?), setTracking(on), isTracking(state?), setMarkupView(view),
// getMarkupView(state?), countChanges(editorState), listChanges(doc).
// Accept / reject core (pure, return a Transaction or null): acceptChange, rejectChange, acceptAll,
// rejectAll, acceptChangesInRange, rejectChangesInRange.
// Pagination: setMarkupViewRepaginate(invalidatePaginationAt) in the composition root.
// UI: TrackChangesButton (`review.track`) and MarkupViewMenu (`review.markup`), wrap in ToolbarItem.
export { TrackChanges, trackChangesKey, setMarkupViewRepaginate, applyMarkupViewAttribute, changedBlockPositions } from './extension'
export type { TrackChangesOptions } from './extension'
export { trackTransaction, cleanSlice, newChangeId, TRACK_SKIP_META, TRACKED_META } from './record'
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
} from './review'
export type { TrackedChange, ChangeKind } from './review'
export { copiedSlice } from './copy'
export { isTracking, setTracking, toggleTrackChanges, getMarkupView, setMarkupView } from './commands'
export { TRACK_CHANGES_CONTROLS, MARKUP_VIEW_OPTIONS, markupViewLabel } from './controls'
export type { MarkupViewOption } from './controls'
export { TrackChangesButton, MarkupViewMenu } from './ReviewControls'
export type { ReviewControlProps } from './ReviewControls'
export { TRACKED_BLOCK_TYPES } from './schema'
