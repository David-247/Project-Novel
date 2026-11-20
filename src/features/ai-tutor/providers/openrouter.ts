import { compatModel } from './compat'
import { listOpenAiModels } from './shared'
import type { ProviderAdapter } from './types'

export const openrouter: ProviderAdapter = {
  id: 'openrouter',
  label: 'OpenRouter',
  connectKinds: ['api_key'],
  keyHelpUrl: 'https://openrouter.ai/keys',
  // OpenRouter's `/models` lists `supported_parameters` per model, so tool support is known, not guessed.
  listModels: (c) => listOpenAiModels(c),
  languageModel: compatModel,
}
