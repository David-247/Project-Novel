import { compatModel } from './compat'
import { curated, listHostedModels } from './shared'
import type { ProviderAdapter } from './types'

// Source: Zhipu AI pricing/model overview, https://docs.bigmodel.cn/cn/guide/start/model-overview (2026-11-19),
// which lists GLM-5.x but says nothing about tools; Alibaba's function-calling page lists GLM-5.x as
// tool-capable, which is why they are marked so here.
const MODELS = curated([
  ['glm-5.3', 'GLM-5.3'],
  ['glm-5.2', 'GLM-5.2'],
])

export const zhipu: ProviderAdapter = {
  id: 'zhipu',
  label: 'GLM (Zhipu AI)',
  connectKinds: ['api_key'],
  keyHelpUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
  listModels: (c) => listHostedModels(c, MODELS),
  languageModel: compatModel,
}
