import { createOpenAI } from '@ai-sdk/openai'
import { curated, sdkOptions } from './shared'
import type { ProviderAdapter } from './types'

// Source: OpenAI API model list, https://developers.openai.com/api/docs/models (read 2026-11-19).
const MODELS = curated([
  ['gpt-6.2-astra', 'GPT-6.2 Astra'],
  ['gpt-6.2-sol', 'GPT-6.2 Sol'],
  ['gpt-6.1-terra', 'GPT-6.1 Terra'],
  ['gpt-6-luna', 'GPT-6 Luna'],
])

export const openai: ProviderAdapter = {
  id: 'openai',
  label: 'OpenAI',
  connectKinds: ['api_key'],
  keyHelpUrl: 'https://platform.openai.com/api-keys',
  listModels: async () => MODELS,
  // `.chat` is Chat Completions (`/chat/completions`); the default model object would use `/responses`.
  languageModel: (c, modelId) => createOpenAI(sdkOptions(c)).chat(modelId),
}
