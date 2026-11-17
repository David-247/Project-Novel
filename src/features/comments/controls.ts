/**
 * Stable identities, names and descriptions of the comment controls (toolbar buttons, panel, cards).
 * The tooltips registry derives its entries from here. Same shape as the editor slice's
 * ToolbarControlMeta, plus the one-line description.
 */
export interface CommentControlMeta {
  id: string
  label: string
  description: string
  shortcut?: string | readonly string[]
}

export const NEW_COMMENT_SHORTCUT = 'Mod-Alt-m'

export const COMMENT_CONTROLS = {
  new: {
    id: 'comment.new',
    label: 'New Comment',
    description: 'Add a comment to the selected text, or to the word at the cursor. It shows in the margin.',
    shortcut: NEW_COMMENT_SHORTCUT,
  },
  panel: {
    id: 'comment.panel',
    label: 'Comments Panel',
    description: 'Show or hide the comments beside the pages. In a narrow window they open as a list.',
  },
  prev: { id: 'comment.prev', label: 'Previous Comment', description: 'Go to the comment before this one in the manuscript.' },
  next: { id: 'comment.next', label: 'Next Comment', description: 'Go to the next comment in the manuscript.' },
  showResolved: {
    id: 'comment.showResolved',
    label: 'Show Resolved',
    description: 'Also show comments you marked as resolved.',
  },
  drawerClose: { id: 'comment.drawerClose', label: 'Close comments', description: 'Close the list of comments and go back to the pages.' },
  jump: { id: 'comment.jump', label: 'Go to text', description: 'Show the text this comment is about, in the manuscript.' },
  composeField: {
    id: 'comment.composeField',
    label: 'New comment',
    description: 'Type your comment. Ctrl+Enter or Cmd+Enter adds it, Escape cancels.',
  },
  composeSubmit: { id: 'comment.composeSubmit', label: 'Comment', description: 'Add the comment to the highlighted text.', shortcut: 'Mod-Enter' },
  composeCancel: { id: 'comment.composeCancel', label: 'Cancel', description: 'Close without adding a comment.', shortcut: 'Escape' },
  replyStart: { id: 'comment.replyStart', label: 'Reply', description: 'Write a reply to this comment.' },
  replyField: {
    id: 'comment.replyField',
    label: 'Reply',
    description: 'Type a reply. Ctrl+Enter or Cmd+Enter sends it, Escape cancels.',
  },
  reply: { id: 'comment.reply', label: 'Send reply', description: 'Add your reply to the thread.', shortcut: 'Mod-Enter' },
  replyCancel: { id: 'comment.replyCancel', label: 'Cancel reply', description: 'Close the reply without sending it.', shortcut: 'Escape' },
  edit: { id: 'comment.edit', label: 'Edit', description: 'Change the text of your message.' },
  editField: {
    id: 'comment.editField',
    label: 'Edit message',
    description: 'Change your message. Ctrl+Enter or Cmd+Enter saves it, Escape cancels.',
  },
  editSave: { id: 'comment.editSave', label: 'Save', description: 'Save the changed message.', shortcut: 'Mod-Enter' },
  editCancel: { id: 'comment.editCancel', label: 'Cancel', description: 'Keep the message as it was.', shortcut: 'Escape' },
  deleteMessage: { id: 'comment.deleteMessage', label: 'Delete reply', description: 'Remove this reply from the thread. Undo brings it back.' },
  resolve: {
    id: 'comment.resolve',
    label: 'Resolve',
    description: 'Mark the comment as done. It is hidden until you show resolved comments. Undo brings it back.',
  },
  reopen: { id: 'comment.reopen', label: 'Reopen', description: 'Mark the resolved comment as open again.' },
  delete: {
    id: 'comment.delete',
    label: 'Delete comment',
    description: 'Remove the comment and all its replies. Undo brings it back.',
  },
} as const satisfies Record<string, CommentControlMeta>

export type CommentControlKey = keyof typeof COMMENT_CONTROLS
