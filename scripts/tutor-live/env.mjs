// The live ghostwriting suite's configuration (scripts/tutor-live-eval.mjs). Plain JS, so both the entry
// script (Node) and the eval run under Vitest (live.eval.ts) read it the same way.
//
// Connections come from the environment, one per provider:
//   NOVEL_LIVE_<PROVIDER>_KEY    the API key (hosted providers; optional for CUSTOM)
//   NOVEL_LIVE_<PROVIDER>_URL    the server address (OLLAMA, LMSTUDIO, CUSTOM: required)
//   NOVEL_LIVE_<PROVIDER>_MODEL  the model (optional: else the adapter's first tool-capable model)
// <PROVIDER> is the provider id in capitals: ANTHROPIC, OPENAI, XAI, DEEPSEEK, ZHIPU, QWEN, OPENROUTER,
// OLLAMA, LMSTUDIO, CUSTOM. Hosts and auth come from Rust's descriptor table (providers.rs), read here,
// so no provider host is written anywhere else.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const PROVIDERS_RS = join(ROOT, 'src-tauri', 'src', 'ai', 'providers.rs')

/** Providers the live suite can use: every descriptor but ChatGPT sign-in (Task 12, no key). */
const USER_HOSTED = ['ollama', 'lmstudio', 'custom']

/**
 * Rust's descriptor table as data: id to { baseUrl (null: the connection's own), auth ('bearer',
 * 'none' or a header name), extraHeaders }. Parsed from the `PROVIDERS` table of providers.rs: the
 * `hosted(...)` and `local(...)` rows and the written-out `ProviderDescriptor { ... }` ones.
 */
export function readDescriptors(source = readFileSync(PROVIDERS_RS, 'utf8')) {
  const table = source.slice(source.indexOf('pub const PROVIDERS'), source.indexOf('];', source.indexOf('pub const PROVIDERS')))
  const out = new Map()
  for (const m of table.matchAll(/\bhosted\("([\w-]+)",\s*"([^"]+)"/g)) out.set(m[1], { baseUrl: m[2], auth: 'bearer', extraHeaders: [] })
  for (const m of table.matchAll(/\blocal\("([\w-]+)",\s*Auth::(\w+)\)/g)) out.set(m[1], { baseUrl: null, auth: m[2] === 'Bearer' ? 'bearer' : 'none', extraHeaders: [] })
  for (const m of table.matchAll(/ProviderDescriptor\s*\{([\s\S]*?)\n\s{4}\},/g)) {
    const body = m[1]
    const id = /\bid:\s*"([\w-]+)"/.exec(body)?.[1]
    if (!id) continue
    const base = /\bbase_url:\s*Some\("([^"]+)"\)/.exec(body)?.[1] ?? null
    const header = /\bauth:\s*Auth::Header\("([^"]+)"\)/.exec(body)?.[1]
    const auth = header ?? (/\bauth:\s*Auth::Bearer/.test(body) ? 'bearer' : 'none')
    const extra = /\bextra_headers:\s*&\[(.*?)\],/s.exec(body)?.[1] ?? ''
    const extraHeaders = [...extra.matchAll(/\("([^"]+)",\s*"([^"]+)"\)/g)].map((h) => [h[1], h[2]])
    out.set(id, { baseUrl: base, auth, extraHeaders })
  }
  return out
}

/**
 * The connections the environment configures, in descriptor order: [{ id, provider, key, baseUrl,
 * model }]. `key` is the secret: it stays in this process and its child, and is never printed.
 */
export function liveConnections(env = process.env, descriptors = readDescriptors()) {
  const out = []
  for (const provider of descriptors.keys()) {
    if (provider === 'chatgpt') continue
    const name = `NOVEL_LIVE_${provider.toUpperCase()}`
    const key = env[`${name}_KEY`]?.trim() || null
    const baseUrl = env[`${name}_URL`]?.trim() || null
    const model = env[`${name}_MODEL`]?.trim() || null
    const configured = USER_HOSTED.includes(provider) ? baseUrl !== null : key !== null
    if (!configured) continue
    out.push({ id: `live-${provider}`, provider, key, baseUrl: USER_HOSTED.includes(provider) ? baseUrl : null, model })
  }
  return out
}
