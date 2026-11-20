// Public surface of the ai-tutor slice (Phase 5). Other slices import only from here.
export { AiFetchError, createTauriFetch, type AiErrorKind } from './net/tauri-fetch'
export { PROVIDER_IDS, USER_HOSTED_PROVIDERS, type Connection, type ProviderId } from './connections/types'
export { getTutorConnections, loadTutorConnections, saveTutorConnections, setActiveTutorConnection } from './connections/store'
export { setSecret, deleteSecret, hasSecret } from './connections/ipc'

// The harness's input side (Task 6; design "Harness: prompt layers" and "Tools"). The prompts are the
// editable Markdown files in ./prompts (charter, scripts, scripted replies).
// - assembleSystem(script | null): charter (always first) + script; scriptedReply(name): replies shown
//   without an AI call (greeting, capabilities, not-connected, offline, ban-warning).
// - bookFacts(): the book facts layer. wrapAttachments(list, idx): the <manuscript> blocks;
//   attachmentText(a, idx): "[pN] text" lines (No Markup, footnotes included) and their word count.
//   Attachment numbers are the writer's: page as the page indicator, chapter as the navigation pane (from 1).
// - createParagraphIndex(editor) + followEditor(idx): session-scoped paragraph ids carried through edits.
// - createReadTools({ idx, scope, requestRead, onScript? }): read_range, find_text, check_spelling,
//   check_grammar, use_script (AI SDK tools).
export { assembleSystem, scriptedReply, scriptText, promptText, isScriptName, SCRIPT_NAMES, CHARTER_SOURCE } from './harness/assemble'
export type { ScriptName, ScriptedReplyName } from './harness/assemble'
export { bookFacts, collectBookFacts, formatBookFacts } from './harness/book-facts'
export type { BookFacts } from './harness/book-facts'
export { attachmentText, attachmentLabel, attachmentRange, wrapAttachments } from './harness/attachments'
export type { Attachment } from './harness/attachments'
export { createParagraphIndex, followEditor } from './harness/paragraph-index'
export type { Location, ParagraphIndex, ParagraphIndexOptions } from './harness/paragraph-index'
export { createReadTools, READ_WORD_LIMIT } from './harness/read-tools'
export type { ReadScope, ReadToolsContext } from './harness/read-tools'

// The harness's output side and the loop (Task 7; design "The no-prose guard").
// - checkMechanical / checkPassage with GUARD_LIMITS: the only code guard, on AI text that would enter
//   the manuscript (propose_change, list_corrections suggestions). Chat text is not filtered.
// - createOutputTools({ idx, corrections, onCorrections, onProposal }): list_corrections, propose_change.
// - createTutorSession(editor): a chat's paragraph ids and corrections, following the editor; corrections
//   turn 'changed' when the writer edits their paragraph. runTutorTurn(args): one turn (streamText).
export { checkMechanical, checkPassage, countChangedWords, splitSentences, GUARD_LIMITS } from './harness/guard'
export type { GuardResult } from './harness/guard'
export { createOutputTools, createCorrectionBook, EXPLAIN_INSTEAD } from './harness/output-tools'
export type { Correction, CorrectionBook, CorrectionKind, CorrectionState, ProposedChange, Rejection, OutputToolsContext } from './harness/output-tools'
export { createTutorSession, runTutorTurn, MAX_STEPS } from './harness/run-turn'
export type { TurnArgs, TurnEvent, TutorSession } from './harness/run-turn'

// Chat history (Task 8): chats live in the app data folder, keyed by the open project's meta.id.
// useTutorHistory(): { chat, chats, error, startNew (returns the chat id), open, append(chatId, msg),
// update(chatId, i, patch), flush, close, refresh, remove, clearProject, clearAll }. Writes name their chat
// and are dropped when it is no longer the open one. The app has no delete-project
// flow, so nothing calls clearProject on delete; Task 10's settings page offers it.
export { useTutorHistory, chatTitle, SAVE_DEBOUNCE_MS } from './history/store'
export type { Chat, ChatSummary, StoredMessage, StoredAttachment } from './history/types'

// The tutor panel (Task 9; design "Chat panel"). Wiring (composition root):
// - <TutorPanel /> as AppShell's `sidePanel`: docked at the right of the pages, floating over them below 768 px.
// - registerTutorCommands(): View ▸ Tutor (Ctrl/Cmd+Shift+Y; ribbon Review ▸ Proofing, and View ▸ Show by
//   its ribbon group's content), "Ask the Tutor About This" in the manuscript's context menu, the chat history flush on
//   quit, the saved connections once preferences are loaded, and a stop on every project change. Returns unregister.
// - setTutorConnectAction(fn): what "Connect a Provider…" opens (Settings).
// - TUTOR_CONTROLS: tooltip copy (the tooltips registry reads it). SparkleIcon: the ribbon's Tutor icon.
export { TutorPanel } from './panel/TutorPanel'
export { registerTutorCommands, openTutor, closeTutor, toggleTutor, isTutorOpen, tutorCommands } from './commands'
export { setTutorConnectAction } from './panel/connect'
export { TUTOR_CONTROLS, TUTOR_SHORTCUT, CONFIRM_WORDS, NO_TOOLS_REASON } from './panel/controls'
export type { TutorControlMeta, TutorControlKey } from './panel/controls'
export { SparkleIcon } from './panel/icons'

// Settings ▸ AI Tutor (Tasks 10, 12): the connections (add, edit, remove, set as default; keys go to the keychain
// only), Continue with ChatGPT and Sign in with OpenRouter (Rust flows; registerTutorCommands listens for the result), and the chat
// history's Clear buttons. The composition root registers the page with the settings slice:
// registerSettingsPage({ id: AI_SETTINGS_PAGE_ID, label: 'AI Tutor', component: AiTutorSettings }).
export { AiTutorSettings } from './settings/AiTutorSettings'
export { AI_SETTINGS_CONTROLS, AI_SETTINGS_PAGE_ID } from './settings/controls'
export type { AiSettingsControlKey } from './settings/controls'
