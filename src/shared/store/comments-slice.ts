import type { SliceCreator } from './types'

/**
 * Comments (Phase 3). The thread data lives in the editor's ProseMirror plugin state (so the main
 * undo history covers every thread action); this slice MIRRORS it for the margin panel and for
 * persistence (comments.json, docs/project-format.md), and holds the panel's UI state. Only the
 * comments slice writes `threads`, after a transaction that changed them (never per keystroke).
 */
export interface CommentMessage {
  id: string
  author: string
  /** ISO 8601 creation time. */
  date: string
  /** Plain text; line breaks kept. */
  text: string
  /** ISO 8601 time of the last edit. */
  editedAt?: string
  /** Unknown keys read from comments.json, written back unchanged. */
  extra?: Record<string, unknown>
}

export interface CommentThread {
  id: string
  /** ISO 8601. */
  createdAt: string
  author: string
  /** `#rrggbb`, or null / absent for the default highlight. */
  authorColor?: string | null
  resolved: boolean
  resolvedBy?: string
  resolvedAt?: string
  /** The first message is the comment; the rest are replies. Never empty. */
  messages: CommentMessage[]
  extra?: Record<string, unknown>
}

export interface CommentsSlice {
  comments: {
    /** Mirror of the editor's threads, oldest first. Includes hidden ones (anchor text deleted). */
    threads: readonly CommentThread[]
    /** Bumps on every thread change made by the user (create, reply, resolve, undo ...), not on load. */
    version: number
    /** Margin panel shown (wide windows). */
    panelOpen: boolean
    /** Drawer / bottom sheet shown (narrow windows). */
    drawerOpen: boolean
    /** Resolved threads shown in the panel (and highlighted). */
    showResolved: boolean
    /** Selected thread: caret in its anchor, its card focused or clicked, Next / Previous Comment. */
    activeId: string | null
    /** Thread whose card or anchor text the pointer is over. */
    hoverId: string | null
    /** New Comment composer is open for this range (not in the document yet). */
    draft: { from: number; to: number } | null
    /** Bumps on each New Comment request (the composer takes the focus again). */
    composeRequest: number
  }
  commentsActions: {
    threadsChanged: (threads: readonly CommentThread[], version: number) => void
    setPanelOpen: (open: boolean) => void
    setDrawerOpen: (open: boolean) => void
    setShowResolved: (show: boolean) => void
    setActive: (id: string | null) => void
    setHover: (id: string | null) => void
    setDraft: (draft: { from: number; to: number } | null) => void
    requestCompose: () => void
  }
}

export const createCommentsSlice: SliceCreator<CommentsSlice> = (set) => {
  const patch = (p: Partial<CommentsSlice['comments']>) =>
    set((s) => {
      const c = s.comments
      return (Object.keys(p) as (keyof typeof p)[]).every((k) => c[k] === p[k]) ? s : { comments: { ...c, ...p } }
    })
  return {
    comments: {
      threads: [],
      version: 0,
      panelOpen: true,
      drawerOpen: false,
      showResolved: false,
      activeId: null,
      hoverId: null,
      draft: null,
      composeRequest: 0,
    },
    commentsActions: {
      threadsChanged: (threads, version) => patch({ threads, version }),
      setPanelOpen: (panelOpen) => patch({ panelOpen }),
      setDrawerOpen: (drawerOpen) => patch({ drawerOpen }),
      setShowResolved: (showResolved) => patch({ showResolved }),
      setActive: (activeId) => patch({ activeId }),
      setHover: (hoverId) => patch({ hoverId }),
      setDraft: (draft) => patch({ draft }),
      requestCompose: () => set((s) => ({ comments: { ...s.comments, composeRequest: s.comments.composeRequest + 1 } })),
    },
  }
}
