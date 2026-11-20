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
