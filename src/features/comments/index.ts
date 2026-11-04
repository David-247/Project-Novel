// Public interface of the "comments" slice (Phase 3: anchored threads in a margin panel).
// Other slices import ONLY from here.
//
// Model: an inline mark `comment` (attr `id`, excludes '' so it overlaps other comments and any other
// mark) anchors a thread; thread data lives outside the text, in the editor plugin state (changed only
// by CommentThreadStep, so the main undo history covers create, reply, edit, resolve, reopen and delete),
// mirrored to the store's `comments` slice, and persisted as the project side file comments.json
// (storage slice; docs/project-format.md).
//
// Wiring (composition root):
// - CommentsExtension in the editor's extension list (editor slice, extensions.ts).
// - registerCommentsSideFile() once at start: comments.json saved / recovered with the manuscript.
// - <CommentsLayout>{paginated view}</CommentsLayout>: margin panel beside the pages, or the drawer
//   in a narrow window, plus the anchor highlights.
// - <NewCommentButton /> (comment.new, Mod-Alt-m) and <CommentsPanelButton /> (comment.panel) in the
//   toolbar (wrap in the editor's ToolbarItem).
// - setCommentAuthorSource(() => ({ name, color })) or CommentsExtension.configure({ getAuthor }):
//   the author (default "Author"); the settings slice supplies it at integration.
// Commands for the command registry / menus: newComment, nextComment, prevComment,
// toggleCommentsPanel, toggleShowResolved, plus the per-thread actions.
export { CommentsExtension, setCommentAuthorSource, currentAuthor } from './extension'
export type { CommentsOptions } from './extension'
export {
  newComment,
  submitDraft,
  cancelDraft,
  nextComment,
  prevComment,
  toggleCommentsPanel,
  toggleShowResolved,
  setShowResolved,
  replyToThread,
  editMessage,
  deleteMessage,
  resolveThread,
  reopenThread,
  deleteThread,
  goToThread,
} from './commands'
export { registerCommentsSideFile } from './persistence'
export { CommentsLayout, commentsDebug } from './CommentsLayout'
export { NewCommentButton, CommentsPanelButton } from './CommentButtons'
export type { CommentButtonProps } from './CommentButtons'
export { COMMENT_CONTROLS, NEW_COMMENT_SHORTCUT } from './controls'
export type { CommentControlMeta, CommentControlKey } from './controls'
export { COMMENTS_FILE, COMMENTS_VERSION } from './model'
export type { Author, CommentThread, CommentMessage } from './model'
export { COMMENT_MARK } from './anchors'
