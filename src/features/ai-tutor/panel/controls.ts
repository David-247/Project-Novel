/**
 * Stable identities, names and descriptions of the tutor panel's controls (Phase 5 Task 9). The
 * tooltips registry derives its entries from here; the toggle (`tutor.toggle`: View menu, ribbon
 * buttons, the shortcut) reads its copy from its registry command.
 */
export interface TutorControlMeta {
  id: string
  label: string
  description: string
  shortcut?: string
}

/**
 * Tutor: Ctrl/Cmd+Shift+Y. Not Ctrl/Cmd+Shift+I (ruling R5: it opens the webview's developer tools in
 * debug builds, as do Ctrl+Shift+J / C and F12). Y is free in the registry on both platforms (Word binds
 * nothing there either); App.menus.test.tsx checks no shortcut is bound twice.
 */
export const TUTOR_SHORTCUT = 'Mod-Shift-y'

/** Sent above this many words, or with Whole Manuscript attached, the panel asks first. */
export const CONFIRM_WORDS = 20_000

export const TUTOR_CONTROLS = {
  toggle: {
    id: 'tutor.toggle',
    label: 'Tutor',
    description: 'Show or hide the AI writing tutor at the right: ask about your text, get corrections to review.',
    shortcut: TUTOR_SHORTCUT,
  },
  close: { id: 'tutor.close', label: 'Close tutor', description: 'Hide the tutor panel. A reply that is still coming is stopped.' },
  history: { id: 'tutor.history', label: 'Chat history', description: "This project's earlier chats with the tutor, to open or delete." },
  newChat: { id: 'tutor.newChat', label: 'New chat', description: 'Start a fresh chat. The current one stays in the chat history.' },
  historyBack: { id: 'tutor.history.back', label: 'Back to chat', description: 'Leave the chat history and return to the current chat.' },
  historyOpen: { id: 'tutor.history.open', label: 'Open chat', description: 'Open this chat to read it or carry on.' },
  historyDelete: { id: 'tutor.history.delete', label: 'Delete chat', description: 'Delete this chat from the history. Asks first; this cannot be undone.' },
  prompt: { id: 'tutor.prompt', label: 'Suggested prompt', description: 'Ask the tutor this. Nothing is sent until you choose it.' },
  composer: {
    id: 'tutor.composer',
    label: 'Ask the tutor',
    description: 'Your question. Enter sends, Shift+Enter adds a line, Backspace when empty removes an attachment.',
  },
  attach: { id: 'tutor.attach', label: 'Add context', description: 'Attach text for the tutor to read: the page, a chapter, the selection or the whole book.' },
  attachPage: { id: 'tutor.attach.page', label: 'Current Page', description: 'Attach the page the cursor is on.' },
  attachChapter: { id: 'tutor.attach.chapter', label: 'Current Chapter', description: 'Attach a chapter: the one you are in, or another from the list.' },
  attachChapterItem: { id: 'tutor.attach.chapterItem', label: 'Chapter', description: 'Attach this chapter.' },
  attachSelection: { id: 'tutor.attach.selection', label: 'Selection', description: 'Attach the selected text. Select some text in the manuscript first.' },
  attachManuscript: {
    id: 'tutor.attach.manuscript',
    label: 'Whole Manuscript',
    description: 'Attach the whole book. You are asked before it is sent, with the number of words.',
  },
  chipRemove: { id: 'tutor.chip.remove', label: 'Remove attachment', description: 'Take this attachment off the message. Backspace does the same.' },
  send: { id: 'tutor.send', label: 'Send', description: 'Send your question and the attachments to the tutor.' },
  stop: { id: 'tutor.stop', label: 'Stop', description: 'Stop the reply. What has arrived so far is kept, marked incomplete.' },
  retry: { id: 'tutor.retry', label: 'Retry', description: 'Ask again, with the same question and attachments.' },
  connect: { id: 'tutor.connect', label: 'Connect a Provider…', description: 'Open Settings to connect the tutor to an AI provider or a model on this computer.' },
  model: { id: 'tutor.model', label: 'Model', description: 'The AI connection and model the tutor uses. Choose another one here.' },
  modelItem: { id: 'tutor.model.item', label: 'Model', description: 'A model of this connection, for the tutor to use.' },
  correctionJump: { id: 'tutor.correction.jump', label: 'Go to text', description: 'Show this text in the manuscript.' },
  correctionFix: { id: 'tutor.correction.fix', label: 'Fix', description: 'Make this correction in the manuscript. Undo takes it back.' },
  correctionIgnore: { id: 'tutor.correction.ignore', label: 'Ignore', description: 'Leave the text as it is and set this correction aside.' },
  proposalOpen: {
    id: 'tutor.proposal.open',
    label: 'Compare Side by Side',
    description: 'Open the suggestion beside your text in the re-write view, to keep your original or the suggestion.',
  },
  readAllow: { id: 'tutor.read.allow', label: 'Allow', description: 'Let the tutor read this part of the manuscript for this question.' },
  readDeny: { id: 'tutor.read.deny', label: "Don't Allow", description: 'Keep this part of the manuscript from the tutor. It answers with what it has.' },
  askAbout: {
    id: 'tutor.askAbout',
    label: 'Ask the Tutor About This',
    description: 'Attach the selection, or the paragraph here, to a new question for the tutor.',
  },
} as const satisfies Record<string, TutorControlMeta>

export type TutorControlKey = keyof typeof TUTOR_CONTROLS

/** A model that cannot call tools: listed, never chosen (Global Constraints, "not supported"). */
export const NO_TOOLS_REASON = "This model can't use tools, so the tutor can't run on it."
