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
  /** The passage was changed in the manuscript (Replace All, accept / reject, undo) after the snapshot. */
  originalChanged?: boolean
  extra?: Record<string, unknown>
}

/** Why the last attempt was refused (shown in the manuscript's re-write notice). */
export type RewriteNotice =
  | { kind: 'locked'; id: string; seq: number }
  | { kind: 'span'; seq: number }
  | { kind: 'missing'; seq: number }

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
      setListOpen: (listOpen) => patch({ listOpen }),
    },
  }
}
