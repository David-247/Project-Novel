import { Mark, mergeAttributes } from '@tiptap/core'
import { Fragment, Slice, type Node as PMNode } from '@tiptap/pm/model'
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'
import { useStore } from '@/shared/store'
import { COMMENT_MARK, collectAnchors, commentIdsAt } from './anchors'
import type { Author, CommentThread } from './model'
import { CommentThreadStep } from './step'

/**
 * The `comment` mark (attr `id`) and the plugin that holds the thread data.
 *
 * - Marks with different ids overlap (`excludes: ''`), also with any other mark (track changes,
 *   formatting): nothing here removes a mark of another type. Not inclusive: typing at the end of
 *   an anchor does not extend it.
 * - Thread state lives in this plugin and changes only through CommentThreadStep (undoable) or a
 *   `load` meta (a project opened; not undoable). After a change it is mirrored to the store
 *   (`comments` slice) for the panel and persistence.
 * - A thread whose anchor text is gone (deleted) is hidden, not destroyed: undo brings the mark
 *   back and the thread shows again. Orphans are pruned when the project closes (persistence.ts).
 * - Paste: a comment mark whose thread is still anchored in the document is dropped from the pasted
 *   copy (a copy does not duplicate the thread); after a cut the thread is no longer anchored, so a
 *   paste keeps the mark (cut and paste moves the comment). Marks without a thread are dropped.
 */
export interface CommentsPluginState {
  threads: ReadonlyMap<string, CommentThread>
  /** Bumps on every change made by steps (user actions, undo, redo); not on load. */
  version: number
  /** Range of the New Comment composer (not in the document yet), mapped through edits. */
  draft: { from: number; to: number } | null
  draftDecorations: DecorationSet
}

export type CommentsMeta = { load: readonly CommentThread[] } | { draft: { from: number; to: number } | null }

export const commentsKey = new PluginKey<CommentsPluginState>('novelComments')

export interface CommentsOptions {
  /** Author of new comments, replies and resolves. The app wires it to the settings slice. */
  getAuthor: () => Author
}

const DEFAULT_AUTHOR: Author = { name: 'Author' }
const defaultGetAuthor = (): Author => DEFAULT_AUTHOR
let authorSource: () => Author = defaultGetAuthor
let currentView: EditorView | null = null

/** The author used for the next thread action (injected; default "Author"). */
export function currentAuthor(): Author {
  try {
    const a = authorSource()
    return a && typeof a.name === 'string' && a.name.trim() ? { name: a.name.trim(), color: a.color ?? null } : DEFAULT_AUTHOR
  } catch {
    return DEFAULT_AUTHOR
  }
}

/** Replace the author source (the composition root wires it to the settings slice). */
export function setCommentAuthorSource(getAuthor: (() => Author) | null): void {
  authorSource = getAuthor ?? (() => DEFAULT_AUTHOR)
}

/** The manuscript view the comments plugin is attached to, or null. */
export function getCommentsView(): EditorView | null {
  return currentView && !(currentView as unknown as { isDestroyed?: boolean }).isDestroyed ? currentView : null
}

export function getPluginState(state: EditorState): CommentsPluginState | undefined {
  return commentsKey.getState(state)
}

export function sortedThreads(threads: ReadonlyMap<string, CommentThread>): CommentThread[] {
  return [...threads.values()].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1))
}

function draftDecorations(doc: PMNode, draft: CommentsPluginState['draft']): DecorationSet {
  if (!draft || draft.from >= draft.to) return DecorationSet.empty
  return DecorationSet.create(doc, [Decoration.inline(draft.from, draft.to, { class: 'nv-comment-draft' })])
}

/** Remove from `slice` every comment mark that may not be pasted (see the header comment). */
export function filterPastedComments(slice: Slice, state: EditorState, moving = false): Slice {
  const type = state.schema.marks[COMMENT_MARK]
  if (!type || moving) return slice
  let found = false
  slice.content.descendants((n) => {
    if (!found && type.isInSet(n.marks)) found = true
    return !found
  })
  if (!found) return slice
  const threads = commentsKey.getState(state)?.threads ?? new Map()
  const anchored = collectAnchors(state.doc)
  const keep = (id: unknown) => typeof id === 'string' && threads.has(id) && !anchored.has(id)
  const strip = (fragment: Fragment): Fragment => {
    const nodes: PMNode[] = []
    fragment.forEach((node) => {
      let n = node.isLeaf || node.isText ? node : node.copy(strip(node.content))
      if (type.isInSet(n.marks)) n = n.mark(n.marks.filter((m) => m.type !== type || keep(m.attrs.id)))
      nodes.push(n)
    })
    return Fragment.from(nodes)
  }
  return new Slice(strip(slice.content), slice.openStart, slice.openEnd)
}

function initialState(): CommentsPluginState {
  // A state created again (remount, whole-document load) keeps the threads the store mirrors; a
  // project open then loads its own (`load` meta).
  const c = useStore.getState().comments
  return { threads: new Map(c.threads.map((t) => [t.id, t])), version: c.version, draft: null, draftDecorations: DecorationSet.empty }
}

function createCommentsPlugin(): Plugin<CommentsPluginState> {
  return new Plugin<CommentsPluginState>({
    key: commentsKey,
    state: {
      init: () => initialState(),
      apply(tr, value) {
        let { threads, version, draft, draftDecorations: decos } = value
        const meta = tr.getMeta(commentsKey) as CommentsMeta | undefined
        if (meta && 'load' in meta) threads = new Map(meta.load.map((t) => [t.id, t]))
        for (const step of tr.steps) {
          if (!(step instanceof CommentThreadStep)) continue
          if (threads === value.threads) threads = new Map(threads)
          const m = threads as Map<string, CommentThread>
          if (step.after) m.set(step.threadId, step.after)
          else m.delete(step.threadId)
          version = value.version + 1
        }
        if (meta && 'draft' in meta) {
          draft = meta.draft
          decos = draftDecorations(tr.doc, draft)
        } else if (draft && tr.docChanged) {
          const from = tr.mapping.map(draft.from, 1)
          const to = tr.mapping.map(draft.to, -1)
          draft = from < to ? { from, to } : null
          decos = draft ? decos.map(tr.mapping, tr.doc) : DecorationSet.empty
        }
        if (threads === value.threads && version === value.version && draft === value.draft && decos === value.draftDecorations) return value
        return { threads, version, draft, draftDecorations: decos }
      },
    },
    props: {
      decorations: (state) => commentsKey.getState(state)?.draftDecorations,
      transformPasted: (slice, view) => filterPastedComments(slice, view.state, !!(view as unknown as { dragging?: { move?: boolean } }).dragging?.move),
      handleDOMEvents: {
        mouseover: (_view, e) => {
          const el = (e.target as Element | null)?.closest?.('[data-comment-id]')
          const id = el?.getAttribute('data-comment-id') ?? null
          if (useStore.getState().comments.hoverId !== id) useStore.getState().commentsActions.setHover(id)
          return false
        },
        mouseleave: () => {
          if (useStore.getState().comments.hoverId !== null) useStore.getState().commentsActions.setHover(null)
          return false
        },
      },
    },
    view(view) {
      currentView = view
      mirror(commentsKey.getState(view.state)!, null)
      return {
        update(v, prev) {
          const now = commentsKey.getState(v.state)!
          const before = commentsKey.getState(prev)
          if (now !== before) mirror(now, before ?? null)
          // The caret in an anchor selects its thread (the card is pulled to it and highlighted).
          if (!v.state.selection.eq(prev.selection)) {
            const ids = commentIdsAt(v.state, v.state.selection.head)
            const id = ids.find((i) => now.threads.has(i)) ?? null
            if (id !== useStore.getState().comments.activeId) useStore.getState().commentsActions.setActive(id)
          }
        },
        destroy() {
          if (currentView === view) currentView = null
        },
      }
    },
  })
}

function mirror(now: CommentsPluginState, before: CommentsPluginState | null): void {
  const actions = useStore.getState().commentsActions
  if (!before || now.threads !== before.threads || now.version !== before.version) {
    actions.threadsChanged(sortedThreads(now.threads), now.version)
  }
  if (!before || now.draft !== before.draft) actions.setDraft(now.draft)
}

/**
 * `comment` mark + thread plugin + Mod-Alt-m (New Comment). Add to the editor's extension list;
 * `CommentsExtension.configure({ getAuthor })` injects the author (default "Author").
 */
export const CommentsExtension = Mark.create<CommentsOptions>({
  name: COMMENT_MARK,
  excludes: '',
  inclusive: false,
  spanning: true,

  addOptions() {
    return { getAuthor: defaultGetAuthor }
  },

  addAttributes() {
    return {
      id: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-comment-id'),
        renderHTML: (attrs) => (attrs.id ? { 'data-comment-id': attrs.id as string } : {}),
      },
    }
  },

  parseHTML() {
    return [{ tag: 'span[data-comment-id]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes({ class: 'nv-comment' }, HTMLAttributes), 0]
  },

  onCreate() {
    if (this.options.getAuthor !== defaultGetAuthor) setCommentAuthorSource(this.options.getAuthor)
  },

  addKeyboardShortcuts() {
    return {
      // New Comment (as in Word).
      'Mod-Alt-m': () => commandHooks.newComment(),
    }
  },

  addProseMirrorPlugins() {
    return [createCommentsPlugin()]
  },
})

/** Set by commands.ts (avoids an import cycle between the extension and the commands). */
export const commandHooks = { newComment: (): boolean => false }
