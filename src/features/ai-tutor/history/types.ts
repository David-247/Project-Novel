import type { ModelMessage } from 'ai'
import type { Correction } from '../harness/output-tools'

/** One attachment of a sent message: its label ("Chapter 3: The Storm") and the text exactly as sent. */
export interface StoredAttachment {
  label: string
  text: string
}

/**
 * A message as stored: the AI SDK message (user text including the attached blocks, as sent) plus what
 * the panel needs to show it again. `incomplete`: the reply stopped early (an error, Stop, the step limit).
 */
export type StoredMessage = ModelMessage & {
  attachments?: StoredAttachment[]
  corrections?: Correction[]
  incomplete?: boolean
}

/** A chat as Rust stores it (src-tauri/src/ai/history.rs). */
export interface Chat {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  connectionId: string
  modelId: string
  messages: StoredMessage[]
}

export interface ChatSummary {
  id: string
  title: string
  updatedAt: string
}
