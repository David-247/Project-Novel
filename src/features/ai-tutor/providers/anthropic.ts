import { createAnthropic } from '@ai-sdk/anthropic'
import { curated, listHostedModels, sdkOptions } from './shared'
import type { ProviderAdapter } from './types'

// Source: Claude API model overview, https://platform.claude.com/docs/en/about-claude/models/overview
// (read 2026-11-19). All of these call tools.
const MODELS = curated([
  ['claude-fable-5-2', 'Claude Fable 5.2'],
  ['claude-opus-5-5', 'Claude Opus 5.5'],
  ['claude-sonnet-5-5', 'Claude Sonnet 5.5'],
  ['claude-haiku-5-5', 'Claude Haiku 5.5'],
])

export const anthropic: ProviderAdapter = {
  id: 'anthropic',
  label: 'Anthropic',
  connectKinds: ['api_key'],
  keyHelpUrl: 'https://console.anthropic.com/settings/keys',
  listModels: (c) => listHostedModels(c, MODELS),
  // Rust's base URL is https://api.anthropic.com/v1, so the SDK's `/messages` becomes `/v1/messages`.
  languageModel: (c, modelId) => createAnthropic(sdkOptions(c)).languageModel(modelId),
}
