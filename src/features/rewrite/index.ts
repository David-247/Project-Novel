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
// - registerRewriteCommands(): Review > Re-write Passage… (Mod-Alt-r), Re-writes…, Next / Previous
//   Re-write, Show Differences (Mod-Shift-d), Flip Pages (Mod-Alt-k), Go to Left / Right Page
//   (Mod-Alt-ArrowLeft / Right), New Version, Close Re-write (command registry; returns unregister).
// - <RewriteHost>{paginated view}</RewriteHost>: the comparison view in place of the pages while a
//   re-write is open, the manuscript's re-write notice and the Re-writes list.
//
// For T9 (keep original / keep this version): getRewrite, passageRange, flushLiveVersions,
// versionDoc, setAnchor, REWRITE_ALLOW_META (see commands.ts).
export { RewriteAnchor, REWRITE_ALLOW_META, REWRITE_SHORTCUT, passageRange, passageRanges, setAnchor, lockedAtSelection } from './anchor'
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
export { registerRewritesSideFile } from './persistence'
export { RewriteHost } from './RewriteHost'
export type { RewriteHostProps } from './RewriteHost'
export { rewriteDebug } from './RewriteView'
export { REWRITE_CONTROLS } from './controls'
export type { RewriteControlMeta, RewriteControlKey } from './controls'
export { REWRITES_FILE, REWRITES_VERSION } from './model'
export { alignBlocks, diffPassages, similarity } from './align'
export type { AlignedRow, PassageDiff } from './align'
