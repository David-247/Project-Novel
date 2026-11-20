import { compatModel } from './compat'
import { curated } from './shared'
import type { ProviderAdapter } from './types'

// Source: Alibaba Cloud Model Studio, https://www.alibabacloud.com/help/en/model-studio/models. The
// stable aliases qwen-max and qwen-plus are its function-calling text models (checked 2026-11-19).
const MODELS = curated([
  ['qwen-max', 'Qwen Max'],
  ['qwen-plus', 'Qwen Plus'],
])

export const qwen: ProviderAdapter = {
  id: 'qwen',
  label: 'Qwen (Alibaba)',
  connectKinds: ['api_key'],
  keyHelpUrl: 'https://modelstudio.console.alibabacloud.com/',
  listModels: async () => MODELS,
  languageModel: compatModel,
}
