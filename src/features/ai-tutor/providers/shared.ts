import { generateText, tool, type LanguageModel } from 'ai'
import { z } from 'zod'
import { createTauriFetch } from '../net/tauri-fetch'
import type { Connection } from '../connections/types'
import type { ListModelsOptions, ModelInfo } from './types'

/**
 * The origin every SDK provider is built with. The fetch shim drops it and forwards only the path;
 * Rust adds the real host (the provider's fixed base URL, which already carries any `/v1`-style
 * prefix, or the connection's saved address). So the SDK must see a bare origin: its own paths
 * (`/messages`, `/chat/completions`, `/models`) are then exactly what Rust expects.
 */
export const PLACEHOLDER_ORIGIN = 'https://provider.invalid'

/** The SDK insists on a key; it is a dummy, stripped by the shim, and Rust adds the stored one. */
export const DUMMY_KEY = 'from-keychain'

export const sdkOptions = (c: Connection) => ({
  baseURL: PLACEHOLDER_ORIGIN,
  apiKey: DUMMY_KEY,
  fetch: createTauriFetch(c.id),
})

/** A curated list entry: these ids are known to support tool calls. */
export const curated = (list: readonly [id: string, label: string][]): ModelInfo[] =>
  list.map(([id, label]) => ({ id, label, tools: 'yes' as const }))

/** GET `/models` (OpenAI-style `{data:[{id}]}`) through the proxy. Tool support is unknown. */
export async function listOpenAiModels(c: Connection, tools: ModelInfo['tools'] = 'unknown'): Promise<ModelInfo[]> {
  const res = await createTauriFetch(c.id)(`${PLACEHOLDER_ORIGIN}/models`, { method: 'GET' })
  if (!res.ok) throw new Error(`Could not list models (HTTP ${res.status}).`)
  const json = (await res.json()) as { data?: { id?: unknown; name?: unknown; display_name?: unknown; supported_parameters?: unknown }[] }
  return (json.data ?? [])
    .filter((m) => typeof m.id === 'string')
    .map((m) => ({
      id: m.id as string,
      label: typeof m.display_name === 'string' ? m.display_name : typeof m.name === 'string' ? m.name : (m.id as string),
      tools: Array.isArray(m.supported_parameters)
        ? m.supported_parameters.includes('tools')
          ? ('yes' as const)
          : ('no' as const)
        : tools,
    }))
}

/** Output budget of the tool probe: room for a reasoning model to think before it calls the tool. */
export const PROBE_MAX_TOKENS = 1024

/**
 * One trivial tool-call request: true when the model answers with any tool call. Never throws. The
 * tool choice is 'auto' (the tutor's own), not 'required': many local servers reject or ignore
 * 'required', and a 64-token cap cut reasoning models off before their call (T3 false negatives).
 */
export async function probeToolCall(model: LanguageModel): Promise<boolean> {
  try {
    const result = await generateText({
      model,
      prompt: 'Call the ping tool now. Do not answer in text.',
      tools: { ping: tool({ description: 'Reply to a ping.', inputSchema: z.object({}) }) },
      toolChoice: 'auto',
      maxRetries: 0,
      maxOutputTokens: PROBE_MAX_TOKENS,
    })
    return result.toolCalls.length > 0
  } catch {
    return false
  }
}

/**
 * A hosted provider's models: the curated list (tool-capable, kept first with its flag) merged with the
 * provider's own `/models`, whose extra ids are `unknown` (unsupported until the user overrides it). Any
 * failure of that request falls back to the curated list alone, so a stale curated id never locks a user out
 * (`strict`, Settings' Test Connection: the failure is thrown, so a wrong key shows).
 */
export async function listHostedModels(c: Connection, list: ModelInfo[], opts?: ListModelsOptions): Promise<ModelInfo[]> {
  let remote: ModelInfo[]
  try {
    remote = await listOpenAiModels(c)
  } catch (e) {
    if (opts?.strict) throw e
    return list
  }
  const known = new Set(list.map((m) => m.id))
  return [...list, ...remote.filter((m) => !known.has(m.id)).map((m) => ({ ...m, tools: 'unknown' as const }))]
}
