import { compatModel, compatProbe } from './compat'
import { listOpenAiModels } from './shared'
import type { ProviderAdapter } from './types'

export const ollama: ProviderAdapter = {
  id: 'ollama',
  label: 'Ollama (local)',
  connectKinds: ['none'],
  listModels: (c) => listOpenAiModels(c),
  languageModel: compatModel,
  probeTools: compatProbe,
}
