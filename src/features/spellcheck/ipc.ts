import { invoke } from '@tauri-apps/api/core'
import type { Block, Finding } from './types'

/** The OS locale as the webview reports it (en-GB selects British spelling; anything else US). */
function osLocale(): string | null {
  try {
    return (typeof navigator !== 'undefined' && (navigator.languages?.[0] ?? navigator.language)) || null
  } catch {
    return null
  }
}

/**
 * Check blocks with Harper (Rust, offline, on the blocking pool). `words` is the writer's dictionary
 * (user plus project): findings on them are dropped there.
 */
export function spellCheck(blocks: Block[], words: string[]): Promise<{ id: string; findings: Finding[] }[]> {
  return invoke('spell_check', { blocks, words, locale: osLocale() })
}
