// Public interface of the "rewrite" slice (Phase 3: re-write view, original and revision side by side).
// Other slices import ONLY from here. docs/design.md, "Re-write"; docs/project-format.md, "rewrites.json".
//
// Model: a passage (whole top-level blocks, at most one chapter) carries the block attribute
// `rewriteId` (anchor; REWRITE_BLOCK_ATTR in @/shared/rewrite). Its re-write (store `rewrite`,
// RewriteRecord) holds the `original` snapshot and the versions, each a passage doc
// `{ type: 'doc', content: [blocks] }`. While a re-write is open (status 'open') its passage is
// read-only in the manuscript; programmatic edits (Replace All, accept / reject, undo, and
// REWRITE_ALLOW_META transactions) pass and mark it "original changed".
//
// Wiring (composition root):
// - RewriteAnchor in the editor's extension list (editor slice, extensions.ts; detached copies for
//   the comparison pages).
// - registerRewritesSideFile() once at start: rewrites.json saved / recovered with the manuscript.
// - registerRewriteCommands(): Review > Re-write Passage… (Mod-Alt-w), Re-writes…, Next / Previous
//   Re-write, Show Differences (Mod-Shift-d), Flip Pages (Mod-Alt-k), Go to Left / Right Page
//   (Mod-Alt-ArrowLeft / Right), New Version, Close Re-write (command registry; returns unregister).
// - <RewriteHost>{paginated view}</RewriteHost>: the comparison view in place of the pages while a
//   re-write is open, the manuscript's re-write notice and the Re-writes list.
// - While the view is open it registers the editor slice's active editor source (text commands act on
//   the revision while it has the focus) and the registry's command gate (manuscript-wide commands off).
//
// The choice (T9; choice.ts): Keep Original, Keep This Version (no default shortcut),
// Discard Re-write, and Reopen from the Re-writes list. Each is one manuscript transaction with a
// RewriteStateStep (step.ts), so one undo reverts it (the re-write open again with every version) and
// redo applies it again; the store / rewrites.json follow the step. Keep This Version is a word-level
// edit (replacePassage), tracked when Track Changes records. setRewriteConfirm(fn): how it asks before
// adding or removing a chapter title (the composition root: the app's message dialog).
export { RewriteAnchor, REWRITE_ALLOW_META, REWRITE_SHORTCUT, passageRange, passageRanges, passageProblem, stripAnchors, setAnchor, lockedAtSelection } from './anchor'
export type { RewriteAnchorOptions, LockedRange } from './anchor'
export {
  rewritePassage,
  openRewrite,
  closeRewrite,
  stepRewrite,
  selectVersion,
  newVersion,
  renameVersion,
  toggleShowDiff,
  toggleFlip,
  focusSide,
  getRewrite,
  versionDoc,
  flushLiveVersions,
  currentPassageDoc,
  goToPassage,
} from './commands'
export { registerRewriteCommands, rewriteCommands } from './menu-commands'
export { keepOriginal, keepVersion, keepVersionNow, discardRewrite, reopenRewrite, locatePassage, setRewriteConfirm } from './choice'
export type { LocateResult } from './choice'
export type { RewriteConfirm, RewriteConfirmRequest } from './choice'
export { replacePassage } from './apply'
export { RewriteStateStep } from './step'
export type { RewriteStepState } from './step'
export { registerRewritesSideFile } from './persistence'
export { RewriteHost } from './RewriteHost'
export type { RewriteHostProps } from './RewriteHost'
export { rewriteDebug } from './RewriteView'
export { REWRITE_CONTROLS } from './controls'
export type { RewriteControlMeta, RewriteControlKey } from './controls'
export { REWRITES_FILE, REWRITES_VERSION, CHOICE_ORIGINAL, withStatus } from './model'
export { alignBlocks, diffPassages, similarity } from './align'
export type { AlignedRow, PassageDiff } from './align'
