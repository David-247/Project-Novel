import { compatModel } from './compat'
import { curated } from './shared'
import type { ProviderAdapter } from './types'

// Source: Zhipu AI open platform model overview, https://docs.bigmodel.cn/cn/guide/start/model-overview
// (read 2026-11-19).
const MODELS = curated([['glm-4.6', 'GLM-4.6']])

export const zhipu: ProviderAdapter = {
  id: 'zhipu',
  label: 'GLM (Zhipu AI)',
  connectKinds: ['api_key'],
  keyHelpUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
  listModels: async () => MODELS,
  languageModel: compatModel,
}
