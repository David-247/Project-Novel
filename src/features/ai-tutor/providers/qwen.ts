import { compatModel } from './compat'
import { curated, listHostedModels } from './shared'
import type { ProviderAdapter } from './types'

// Source: https://www.alibabacloud.com/help/en/model-studio/models and its qwen-function-calling page
// (2026-11-19). These are API model ids, not family labels.
const MODELS = curated([
  ['qwen4-max', 'Qwen4 Max'],
  ['qwen3.7-plus', 'Qwen3.7 Plus'],
  ['qwen3.8-flash', 'Qwen3.8 Flash'],
])

export const qwen: ProviderAdapter = {
  id: 'qwen',
  label: 'Qwen (Alibaba)',
  connectKinds: ['api_key'],
  keyHelpUrl: 'https://modelstudio.console.alibabacloud.com/',
  listModels: (c, opts) => listHostedModels(c, MODELS, opts),
  languageModel: compatModel,
}
