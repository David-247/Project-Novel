import { compatModel, compatProbe } from './compat'
import { listOpenAiModels } from './shared'
import type { ProviderAdapter } from './types'

export const ollama: ProviderAdapter = {
  id: 'ollama',
  label: 'Ollama (local)',
  connectKinds: ['none'],
  defaultBaseUrl: 'http://localhost:11434/v1',
  apiPath: '/v1',
  listModels: (c) => listOpenAiModels(c),
  languageModel: compatModel,
  probeTools: compatProbe,
}
