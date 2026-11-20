import { createOpenAI } from '@ai-sdk/openai'
import { wrapLanguageModel, type LanguageModel, type LanguageModelMiddleware } from 'ai'
import { createTauriFetch } from '../net/tauri-fetch'
import type { Connection } from '../connections/types'
import { PLACEHOLDER_ORIGIN, sdkOptions } from './shared'
import type { ModelInfo, ProviderAdapter } from './types'

/**
 * Sign in with ChatGPT: the writer's ChatGPT plan, through OpenAI's documented flow for open-source,
 * locally run apps (docs/research/chatgpt-sign-in.md). Rust signs in, keeps the tokens in the keychain,
 * refreshes them and adds the access token (src-tauri/src/ai/chatgpt.rs); requests go to the public
 * Responses API (`POST /responses`), never to ChatGPT's backend.
 *
 * The plan route's preview rules (https://developers.openai.com/siwc/token-sharing-open-source/
 * preview-limitations, read 2026-11-19), applied to every request by `planRules`:
 * - `store: false` and `stream: true` (the tutor only streams: `streamText`);
 * - instructions as developer messages (explicit `system` items are rejected);
 * - function tools grouped in a namespace;
 * - no `temperature`, `top_p`, `max_output_tokens` and the other fields the route refuses.
 */

/** The namespace the tutor's tools are grouped in (the route asks for namespaced function tools). */
export const TOOL_NAMESPACE = { name: 'novel', description: 'Novel tutor tools: read the manuscript and propose corrections.' }

export const planRules: LanguageModelMiddleware = {
  specificationVersion: 'v4',
  transformParams: async ({ params }) => {
    const openai = { ...(params.providerOptions?.openai ?? {}), store: false, systemMessageMode: 'developer' }
    const tools = params.tools?.map((t) =>
      t.type === 'function'
        ? { ...t, providerOptions: { ...t.providerOptions, openai: { ...(t.providerOptions?.openai ?? {}), namespace: TOOL_NAMESPACE } } }
        : t,
    )
    const rest = { ...params }
    delete rest.temperature
    delete rest.topP
    delete rest.topK
    delete rest.maxOutputTokens
    delete rest.presencePenalty
    delete rest.frequencyPenalty
    delete rest.seed
    return { ...rest, ...(tools ? { tools } : {}), providerOptions: { ...params.providerOptions, openai } }
  },
}

/**
 * The signed-in account's models: `GET /models` with the plan token answers `{ models: [{ slug,
 * display_name, visibility }] }`; only `visibility: "list"` is shown, in the server's order. The route
 * supports namespaced function tools, so the tutor's tools work with each listed model. There is no
 * curated fallback: the list is the account's own.
 */
export async function listPlanModels(c: Connection): Promise<ModelInfo[]> {
  const res = await createTauriFetch(c.id)(`${PLACEHOLDER_ORIGIN}/models`, { method: 'GET' })
  if (!res.ok) throw new Error(`Could not list the models of your ChatGPT plan (HTTP ${res.status}).`)
  const json = (await res.json()) as { models?: { slug?: unknown; display_name?: unknown; visibility?: unknown }[] }
  return (json.models ?? [])
    .filter((m) => typeof m.slug === 'string' && m.slug && (m.visibility === undefined || m.visibility === 'list'))
    .map((m) => ({ id: m.slug as string, label: typeof m.display_name === 'string' && m.display_name ? m.display_name : (m.slug as string), tools: 'yes' as const }))
}

export const chatgpt: ProviderAdapter = {
  id: 'chatgpt',
  label: 'ChatGPT',
  connectKinds: ['oauth'],
  signIn: { control: 'signInChatGpt', site: 'ChatGPT', consumerPlan: true, renewable: true, usagePage: true },
  listModels: (c) => listPlanModels(c),
  // `.responses`: the Responses API, the only route the plan token may call.
  languageModel: (c, modelId): LanguageModel => wrapLanguageModel({ model: createOpenAI(sdkOptions(c)).responses(modelId), middleware: planRules }),
}
