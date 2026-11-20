import { compatModel } from './compat'
import { listOpenAiModels } from './shared'
import type { ProviderAdapter } from './types'

export const openrouter: ProviderAdapter = {
  id: 'openrouter',
  label: 'OpenRouter',
  // An API key, or Sign in with OpenRouter (OAuth PKCE in Rust, src-tauri/src/ai/oauth.rs).
  connectKinds: ['api_key', 'oauth'],
  keyHelpUrl: 'https://openrouter.ai/keys',
  signIn: { control: 'signIn', site: 'OpenRouter', consumerPlan: false, renewable: false, usagePage: false },
  // OpenRouter's `/models` lists `supported_parameters` per model, so tool support is known, not guessed.
  listModels: (c) => listOpenAiModels(c),
  languageModel: compatModel,
}
