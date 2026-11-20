/** The providers the tutor can talk to. Rust's descriptor table (src-tauri/src/ai/providers.rs) has one row per id. */
export const PROVIDER_IDS = [
  'anthropic',
  'openai',
  'xai',
  'deepseek',
  'zhipu',
  'qwen',
  'openrouter',
  'ollama',
  'lmstudio',
  'custom',
  'chatgpt',
] as const

export type ProviderId = (typeof PROVIDER_IDS)[number]

/** Providers whose host is the user's saved `baseUrl` (Rust ignores a `baseUrl` on any other). */
export const USER_HOSTED_PROVIDERS: readonly ProviderId[] = ['ollama', 'lmstudio', 'custom']

/**
 * A saved AI connection (ai-connections.json in the app data dir). It never holds a secret: keys live
 * in the OS keychain, written through `ipc.setSecret` and never read back by the webview.
 */
export interface Connection {
  /** Also the keychain account name. */
  id: string
  provider: ProviderId
  label: string
  auth: 'api_key' | 'oauth' | 'none'
  /** Ollama, LM Studio and custom only; http or https, no query, fragment or user name. */
  baseUrl?: string
  defaultModel?: string
  /** Per model id: whether the model was found to support tool calls. */
  toolSupport?: Record<string, boolean>
  /** The user accepted plain http to a non-loopback host (a LAN server) for this connection. */
  insecureHttpAccepted?: boolean
}
