import { compatModel, compatProbe } from './compat'
import { listOpenAiModels } from './shared'
import type { ProviderAdapter } from './types'

export const lmstudio: ProviderAdapter = {
  id: 'lmstudio',
  label: 'LM Studio (local)',
  connectKinds: ['none'],
  listModels: (c) => listOpenAiModels(c),
  languageModel: compatModel,
  probeTools: compatProbe,
}
