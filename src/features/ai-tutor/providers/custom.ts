import { compatModel, compatProbe } from './compat'
import { listOpenAiModels } from './shared'
import type { ProviderAdapter } from './types'

export const custom: ProviderAdapter = {
  id: 'custom',
  label: 'Custom (OpenAI-compatible)',
  connectKinds: ['api_key', 'none'],
  listModels: (c) => listOpenAiModels(c),
  languageModel: compatModel,
  probeTools: compatProbe,
}
