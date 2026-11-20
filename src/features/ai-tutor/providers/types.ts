import type { LanguageModel } from 'ai'
import type { Connection, ProviderId } from '../connections/types'

export interface ModelInfo {
  id: string
  label: string
  /** Whether the model can call tools: known from a curated list or the provider's own metadata, else unknown. */
  tools: 'yes' | 'no' | 'unknown'
}

/**
 * One thin adapter per provider. Everything provider-specific lives behind this interface, under
 * `providers/`; the rest of the slice only sees adapters.
 */
export interface ProviderAdapter {
  id: ProviderId
  label: string
  connectKinds: Connection['auth'][]
  keyHelpUrl?: string
  listModels(c: Connection): Promise<ModelInfo[]>
  languageModel(c: Connection, modelId: string): LanguageModel
  /** Local and custom providers only: send one trivial tool-call request; true only if the reply calls the tool. */
  probeTools?(c: Connection, modelId: string): Promise<boolean>
}
