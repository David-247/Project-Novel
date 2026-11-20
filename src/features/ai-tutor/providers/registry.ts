import type { Connection, ProviderId } from '../connections/types'
import { anthropic } from './anthropic'
import { custom } from './custom'
import { deepseek } from './deepseek'
import { lmstudio } from './lmstudio'
import { ollama } from './ollama'
import { openai } from './openai'
import { openrouter } from './openrouter'
import { qwen } from './qwen'
import type { ModelInfo, ProviderAdapter } from './types'
import { xai } from './xai'
import { zhipu } from './zhipu'

// The ChatGPT sign-in provider gets its adapter in Task 12.
const ADAPTERS = [anthropic, openai, xai, deepseek, zhipu, qwen, openrouter, ollama, lmstudio, custom] satisfies ProviderAdapter[]

export const listAdapters = (): ProviderAdapter[] => [...ADAPTERS]

export function getAdapter(id: ProviderId): ProviderAdapter {
  const adapter = ADAPTERS.find((a) => a.id === id)
  if (!adapter) throw new Error(`No adapter for provider "${id}".`)
  return adapter
}

/** Whether the tutor may use tools with this model: the user's override, else the curated/probed answer, else no. */
export function modelSupportsTools(c: Connection, m: ModelInfo): boolean {
  const override = c.toolSupport?.[m.id]
  if (override !== undefined) return override
  return m.tools === 'yes'
}
