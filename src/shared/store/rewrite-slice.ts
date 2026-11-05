import type { DocNodeJSON } from '@/shared/document'
import type { SliceCreator } from './types'

/**
 * Re-write (Phase 3). The re-writes of the project (rewrites.json, docs/project-format.md) and the
 * comparison view's UI state. Only the rewrite slice writes here. The revision being typed lives in
 * that slice's editor; its document is copied here debounced (and before every save / snapshot), so
 * typing never re-renders store subscribers.
 */
export interface RewriteVersion {
  id: string
  /** Shown on the version's tab; the user can rename it. */
  name: string
  /** The revised passage: `{ type: 'doc', content: [blocks] }` (ProseMirror JSON). */
  doc: DocNodeJSON
  /** ISO 8601 time of the last edit. */
  updatedAt: string
  /** Unknown keys read from rewrites.json, written back unchanged. */
  extra?: Record<string, unknown>
}

export type RewriteStatus = 'open' | 'resolved'

/** Where a resolved re-write's passage was (rewrites.json `location`). */
export interface RewriteLocation {
  /** Top-level block index of the passage's first block. */
  block: number
  /** Chapter index there (-1 before the first chapter). */
  chapter: number
  /** The start of the paragraph before and after the passage (plain text, up to 60 characters; '' at an edge). */
  before: string
  after: string
}

export interface RewriteRecord {
  id: string
  /** ISO 8601. */
  createdAt: string
  /** Value of the `rewriteId` block attribute on the passage's blocks in the manuscript. */
  anchor: string
  /** The passage as it was when the re-write was made: `{ type: 'doc', content: [blocks] }`. */
  original: DocNodeJSON
  /** Never empty. */
  versions: RewriteVersion[]
  /** The version shown when the re-write is opened (last one viewed). */
  currentVersionId?: string
  status: RewriteStatus
  /**
   * A `status` rewrites.json gave that this Novel does not know (a newer one): treated as 'resolved'
   * and written back as it was. Setting a status (withStatus in the rewrite slice) drops it.
   */
  unknownStatus?: unknown
  /** The passage was changed in the manuscript (Replace All, accept / reject, undo) after the snapshot. */
  originalChanged?: boolean
  /**
   * How a resolved re-write was resolved: 'original' (Keep Original) or the id of the version kept
   * (Keep This Version). Absent while open.
   */
  choice?: string
  /** ISO 8601 time of the choice. Absent while open. */
  resolvedAt?: string
  /**
   * Keep This Version: a frozen copy of the passage that was kept (the version as it was then), so the
   * record stays true to the manuscript when the version is edited later. Absent while open.
   */
  kept?: DocNodeJSON
  /** Where the passage was when it resolved: Reopen looks there first. Absent while open. */
  location?: RewriteLocation
  extra?: Record<string, unknown>
}

/** Why the last attempt was refused (shown in the manuscript's re-write notice). */
export type RewriteNotice =
  | { kind: 'locked'; id: string; seq: number }
  | { kind: 'undo'; id: string; seq: number }
  | { kind: 'span'; seq: number }
  | { kind: 'missing'; id?: string; seq: number }
  | { kind: 'split'; id?: string; seq: number }
  /** Reopen: the kept text of a resolved re-write was not found in the manuscript. */
  | { kind: 'notFound'; ambiguous?: boolean; seq: number }
  /** Discard Re-write: undo brings it back. */
  | { kind: 'discarded'; seq: number }

export interface RewriteSlice {
  rewrite: {
    rewrites: readonly RewriteRecord[]
    /** Bumps on every change made by the user (create, edit a version, rename ...), not on load. */
    version: number
    /** The re-write shown in the comparison view, or null (the manuscript is shown). */
    openId: string | null
    /** The version on the revised page. */
    activeVersionId: string | null
    /** Show differences: word-level highlights on both pages. */
    showDiff: boolean
    /** The revision is on the left page, the original on the right. */
    flipped: boolean
    /** Narrow windows show one page at a time: which one. */
    narrowSide: 'original' | 'revised'
    /** "Original changed": the original page shows the passage as it is now in the manuscript. */
    showCurrent: boolean
    /** The open re-write whose locked passage holds the manuscript's caret, or null. */
    caretIn: string | null
    notice: RewriteNotice | null
    /** Open re-writes whose passage is not in the manuscript as one run now (anchor id -> problem). */
    problems: Readonly<Record<string, 'missing' | 'split'>>
    /** Review ▸ Re-writes list dialog. */
    listOpen: boolean
  }
  rewriteActions: {
    /** A project was opened / created: replace everything (not a user change). */
    loaded: (rewrites: readonly RewriteRecord[]) => void
    /** The user changed the re-writes. */
    changed: (rewrites: readonly RewriteRecord[]) => void
    open: (id: string, versionId: string | null) => void
    close: () => void
    setActiveVersion: (id: string | null) => void
    setShowDiff: (on: boolean) => void
    setFlipped: (on: boolean) => void
    setNarrowSide: (side: 'original' | 'revised') => void
    setShowCurrent: (on: boolean) => void
    setCaretIn: (id: string | null) => void
    setNotice: (notice: RewriteNotice | null) => void
    setProblems: (problems: Readonly<Record<string, 'missing' | 'split'>>) => void
    setListOpen: (open: boolean) => void
  }
}

export const createRewriteSlice: SliceCreator<RewriteSlice> = (set) => {
  const patch = (p: Partial<RewriteSlice['rewrite']>) =>
    set((s) => {
      const r = s.rewrite
      return (Object.keys(p) as (keyof typeof p)[]).every((k) => r[k] === p[k]) ? s : { rewrite: { ...r, ...p } }
    })
  return {
    rewrite: {
      rewrites: [],
      version: 0,
      openId: null,
      activeVersionId: null,
      showDiff: true,
      flipped: false,
      narrowSide: 'revised',
      showCurrent: false,
      caretIn: null,
      notice: null,
      problems: {},
      listOpen: false,
    },
    rewriteActions: {
      loaded: (rewrites) => patch({ rewrites, openId: null, activeVersionId: null, showCurrent: false, caretIn: null, notice: null, listOpen: false }),
      changed: (rewrites) => set((s) => ({ rewrite: { ...s.rewrite, rewrites, version: s.rewrite.version + 1 } })),
      open: (openId, activeVersionId) => patch({ openId, activeVersionId, showCurrent: false, notice: null, listOpen: false }),
      close: () => patch({ openId: null, activeVersionId: null, showCurrent: false }),
      setActiveVersion: (activeVersionId) => patch({ activeVersionId }),
      setShowDiff: (showDiff) => patch({ showDiff }),
      setFlipped: (flipped) => patch({ flipped }),
      setNarrowSide: (narrowSide) => patch({ narrowSide }),
      setShowCurrent: (showCurrent) => patch({ showCurrent }),
      setCaretIn: (caretIn) => patch({ caretIn }),
      setNotice: (notice) => patch({ notice }),
      setProblems: (problems) => patch({ problems }),
      setListOpen: (listOpen) => patch({ listOpen }),
    },
  }
}
