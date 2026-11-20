import { compatModel, compatProbe } from './compat'
import { listOpenAiModels } from './shared'
import type { ProviderAdapter } from './types'

export const lmstudio: ProviderAdapter = {
  id: 'lmstudio',
  label: 'LM Studio (local)',
  connectKinds: ['none'],
  defaultBaseUrl: 'http://localhost:1234/v1',
  apiPath: '/v1',
  listModels: (c) => listOpenAiModels(c),
  languageModel: compatModel,
  probeTools: compatProbe,
}
