// The webview's side of the chat history commands (src-tauri/src/ai/history.rs). Both ids must match
// ^[A-Za-z0-9-]{1,64}$ (Rust rejects anything else as bad_request).
import { invoke } from '@tauri-apps/api/core'
import type { Chat, ChatSummary } from './types'

export function listChats(projectId: string): Promise<ChatSummary[]> {
  return invoke<ChatSummary[]>('tutor_history_list', { projectId })
}

export function loadChat(projectId: string, chatId: string): Promise<Chat> {
  return invoke<Chat>('tutor_history_load', { projectId, chatId })
}

/** Atomic; Rust refuses a chat over 8 MB. */
export function saveChat(projectId: string, chat: Chat): Promise<void> {
  return invoke<void>('tutor_history_save', { projectId, chat })
}

/** One chat; without `chatId`, all of the project's chats. */
export function deleteChats(projectId: string, chatId?: string): Promise<void> {
  return invoke<void>('tutor_history_delete', { projectId, chatId: chatId ?? null })
}

/** Every project's chats (the settings page's "Clear all"). */
export function clearAllChats(): Promise<void> {
  return invoke<void>('tutor_history_clear_all')
}
