/**
 * Re-write (Phase 3): the names other slices need without importing the rewrite slice
 * (docs/project-format.md, "rewrites.json").
 */

/**
 * Block attribute anchoring a re-write: every top-level block of the passage carries the re-write's
 * anchor id. `null` (absent from manuscript.json) on every other block.
 */
export const REWRITE_BLOCK_ATTR = 'rewriteId'

/**
 * Transaction meta `true`: a bulk edit made by the app, not typed by the user (Replace All). It may
 * change a passage that is locked by an open re-write; the re-write is then marked "original changed".
 */
export const BULK_EDIT_META = 'nvBulkEdit'
