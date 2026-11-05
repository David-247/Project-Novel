import { registerSideFile, type ProjectSideFile } from '@/features/storage'
import { useStore } from '@/shared/store'
import { collectAnchors } from './anchors'
import { currentThreads, loadThreads } from './commands'
import { getCommentsView } from './extension'
import { COMMENTS_FILE, parseCommentsFile, serializeCommentsFile, type CommentThread } from './model'

/**
 * comments.json as a project side file (storage slice): read on open, written in one batch with the
 * manuscript on every save, snapshotted by autosave, guarded when damaged or newer.
 *
 * - Hidden threads (anchor text deleted) are saved: undo may bring the anchor back.
 * - On open and on close (when the project is saved) threads without an anchor in the manuscript are
 *   pruned: undo history does not outlive the session, so nothing can bring them back.
 * - Unknown keys (top level, threads, messages) and thread entries this version cannot read are
 *   written back unchanged.
 */
let fileExtra: Record<string, unknown> = {}
let unreadable: unknown[] = []

function anchoredIds(): ReadonlySet<string> | null {
  const v = getCommentsView()
  return v ? new Set(collectAnchors(v.state.doc).keys()) : null
}

function withoutOrphans(threads: readonly CommentThread[]): CommentThread[] | null {
  const anchored = anchoredIds()
  if (!anchored) return null
  const kept = threads.filter((t) => anchored.has(t.id))
  return kept.length === threads.length ? null : kept
}

export const commentsSideFile: ProjectSideFile = {
  name: COMMENTS_FILE,
  load(data) {
    const parsed = parseCommentsFile(data)
    fileExtra = parsed.extra
    unreadable = parsed.unreadable
    loadThreads(withoutOrphans(parsed.threads) ?? parsed.threads)
    return parsed.newer !== undefined ? { newer: parsed.newer } : undefined
  },
  serialize() {
    const threads = currentThreads()
    return {
      data: serializeCommentsFile({ threads: [...threads], extra: fileExtra, unreadable }),
      empty: threads.length === 0 && unreadable.length === 0 && Object.keys(fileExtra).length === 0,
    }
  },
  getVersion: () => useStore.getState().comments.version,
  closeData() {
    const pruned = withoutOrphans(currentThreads())
    return pruned ? serializeCommentsFile({ threads: pruned, extra: fileExtra, unreadable }) : null
  },
}

/** Register comments.json with the storage slice (once, at app start). Returns unregister. */
export function registerCommentsSideFile(): () => void {
  return registerSideFile(commentsSideFile)
}

/** Test-only. */
export function __resetCommentsFileForTests(): void {
  fileExtra = {}
  unreadable = []
}
