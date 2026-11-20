import { createDeepSeek } from '@ai-sdk/deepseek'
import { curated, listHostedModels, sdkOptions } from './shared'
import type { ProviderAdapter } from './types'

// Source: DeepSeek models and pricing, https://api-docs.deepseek.com/quick_start/pricing (read 2026-11-19;
// the table marks tool calls as supported for both).
const MODELS = curated([
  ['deepseek-v4-pro', 'DeepSeek V4 Pro'],
  ['deepseek-flash', 'DeepSeek Flash'],
])

export const deepseek: ProviderAdapter = {
  id: 'deepseek',
  label: 'DeepSeek',
  connectKinds: ['api_key'],
  keyHelpUrl: 'https://platform.deepseek.com/api_keys',
  listModels: (c) => listHostedModels(c, MODELS),
  languageModel: (c, modelId) => createDeepSeek(sdkOptions(c)).chat(modelId),
}
