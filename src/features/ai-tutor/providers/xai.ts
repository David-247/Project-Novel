import { createXai } from '@ai-sdk/xai'
import { curated, listHostedModels, sdkOptions } from './shared'
import type { ProviderAdapter } from './types'

// Source: xAI model list, https://docs.x.ai/developers/models (read 2026-11-19).
const MODELS = curated([['grok-4.7', 'Grok 4.7']])

// The current xAI SDK exposes the Responses API only (`/responses`, served under Rust's https://api.x.ai/v1).
export const xai: ProviderAdapter = {
  id: 'xai',
  label: 'xAI',
  connectKinds: ['api_key'],
  keyHelpUrl: 'https://console.x.ai',
  listModels: (c, opts) => listHostedModels(c, MODELS, opts),
  languageModel: (c, modelId) => createXai(sdkOptions(c)).languageModel(modelId),
}
