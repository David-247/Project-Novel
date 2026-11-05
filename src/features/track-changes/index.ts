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
export { TrackChanges, setTrackChangesAuthorSource, currentTrackAuthor, trackChangesKey, setMarkupViewRepaginate, applyMarkupViewAttribute, changedBlockPositions, skipDeleted, TRACK_FAILED_NOTICE, flushComposedText, COMPOSITION_FLUSH_MS } from './extension'
export type { TrackChangesOptions } from './extension'
export { trackTransaction, cleanSlice, newChangeId, markComposed, TRACK_SKIP_META, TRACKED_META, TRACK_FAILED_META, DEFERRED_INSERT_META } from './record'
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
} from './review'
export type { TrackedChange, ChangeKind } from './review'
export { copiedSlice } from './copy'
export { isTracking, setTracking, toggleTrackChanges, getMarkupView, setMarkupView, setOnTrackingSwitchedOn } from './commands'
export { registerTrackChangesCommands, trackChangesCommands } from './menu-commands'
export { TRACK_CHANGES_CONTROLS, MARKUP_VIEW_OPTIONS, markupViewLabel } from './controls'
export type { MarkupViewOption } from './controls'
export { TrackChangesButton, MarkupViewMenu, TrackChangesNotice } from './ReviewControls'
export type { ReviewControlProps } from './ReviewControls'
export { TRACKED_BLOCK_TYPES } from './schema'
