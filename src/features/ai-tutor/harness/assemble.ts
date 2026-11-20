import charter from '../prompts/charter.md?raw'
import explainRule from '../prompts/scripts/explain-rule.md?raw'
import format from '../prompts/scripts/format.md?raw'
import general from '../prompts/scripts/general.md?raw'
import pacing from '../prompts/scripts/pacing.md?raw'
import proofread from '../prompts/scripts/proofread.md?raw'
import stuck from '../prompts/scripts/stuck.md?raw'
import banWarning from '../prompts/scripted/ban-warning.md?raw'
import capabilities from '../prompts/scripted/capabilities.md?raw'
import greeting from '../prompts/scripted/greeting.md?raw'
import notConnected from '../prompts/scripted/not-connected.md?raw'
import offline from '../prompts/scripted/offline.md?raw'

/**
 * The system prompt's layers (docs/superpowers/specs/2026-11-19-ai-tutor-design.md, "Harness: prompt
 * layers"). The prompts are Markdown files in ../prompts, written for a human editor to tune; they are
 * bundled as text (Vite `?raw`). Their HTML comments (what a file is for, the `rule:` markers the tests
 * check) are for those editors and are not sent to the model.
 *
 * 1. charter.md, always first and never overridable;
 * 2. one script (scripts/<name>.md): chosen by a suggested prompt, or by the model with `use_script`;
 * 3. book facts (book-facts.ts) and 4. the attached text (attachments.ts) follow, built at send time.
 */
export type ScriptName = 'proofread' | 'format' | 'pacing' | 'stuck' | 'explain-rule' | 'general'
export const SCRIPT_NAMES: readonly ScriptName[] = ['proofread', 'format', 'pacing', 'stuck', 'explain-rule', 'general']

/** Replies shown without any AI call. */
export type ScriptedReplyName = 'greeting' | 'capabilities' | 'not-connected' | 'offline' | 'ban-warning'

/** charter.md as written (comments included). */
export const CHARTER_SOURCE: string = charter

const SCRIPTS: Record<ScriptName, string> = { proofread, format, pacing, stuck, 'explain-rule': explainRule, general }
const SCRIPTED: Record<ScriptedReplyName, string> = { greeting, capabilities, 'not-connected': notConnected, offline, 'ban-warning': banWarning }

/** A prompt file as the model reads it: without HTML comments, blank-line runs collapsed, trimmed. */
export function promptText(source: string): string {
  return source
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function scriptText(name: ScriptName): string {
  return promptText(SCRIPTS[name])
}

export const isScriptName = (name: unknown): name is ScriptName => typeof name === 'string' && (SCRIPT_NAMES as readonly string[]).includes(name)

/** The system prompt: the charter, then the script when there is one. */
export function assembleSystem(script: ScriptName | null): string {
  const base = promptText(CHARTER_SOURCE)
  return script ? `${base}\n\n${scriptText(script)}` : base
}

/** A scripted reply's Markdown (shown in the panel as the tutor's message; no AI call). */
export function scriptedReply(name: ScriptedReplyName): string {
  return promptText(SCRIPTED[name])
}
