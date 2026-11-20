import type { LanguageModel } from 'ai'
import type { Connection, ProviderId } from '../connections/types'

export interface ListModelsOptions {
  /** Throw when the provider cannot be reached or refuses, instead of falling back. */
  strict?: boolean
}

export interface ModelInfo {
  id: string
  label: string
  /** Whether the model can call tools: known from a curated list or the provider's own metadata, else unknown. */
  tools: 'yes' | 'no' | 'unknown'
}

/** A "Sign in with ..." the settings page offers for this provider (Rust runs the flow, oauth.rs / chatgpt.rs). */
export interface SignInInfo {
  /** The button's entry in the settings controls (settings/controls.ts). */
  control: 'signIn' | 'signInChatGpt'
  /** Who the browser opens at, for "Finish signing in to ... in your browser." */
  site: string
  /** A consumer subscription: the ban warning (prompts/scripted/ban-warning.md) is shown once before the first sign-in. */
  consumerPlan: boolean
  /** A saved connection can be signed in again in place ("Sign In Again"; ChatGPT keeps its registration). */
  renewable: boolean
  /** Rust can open the provider's usage page ("Manage Usage"). */
  usagePage: boolean
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
  /** Offered on Settings as its own button (OpenRouter, ChatGPT). */
  signIn?: SignInInfo
  /** Local servers: the address Settings starts with. */
  defaultBaseUrl?: string
  /** Local servers: the API path added when only the server was typed (`/v1`: their OpenAI-compatible API). */
  apiPath?: string
  /**
   * The connection's models. A hosted provider falls back to its curated list when its `/models` fails
   * (R9), unless `strict` (Settings' Test Connection), which reports the failure instead.
   */
  listModels(c: Connection, opts?: ListModelsOptions): Promise<ModelInfo[]>
  languageModel(c: Connection, modelId: string): LanguageModel
  /** Local and custom providers only: send one trivial tool-call request; true only if the reply calls the tool. */
  probeTools?(c: Connection, modelId: string): Promise<boolean>
}
