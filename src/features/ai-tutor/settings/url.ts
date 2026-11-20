/**
 * The address checks the AI Tutor settings page makes before it saves a local or custom connection.
 * Rust validates again (connections.rs `check_base_url`) and enforces the http rule (fetch.rs).
 */

const parse = (raw: string): URL | null => {
  try {
    return new URL(raw)
  } catch {
    return null
  }
}

/**
 * Ruling R8, as Rust's `is_loopback`: the host `localhost` and loopback IP literals (127.0.0.0/8, ::1)
 * only. Any other name, `*.localhost` included, is not trusted to be this computer.
 */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase()
  if (host === 'localhost' || host === '::1' || host === '0:0:0:0:0:0:0:1') return true
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  return !!v4 && v4.slice(1).every((p) => Number(p) <= 255) && v4[1] === '127'
}

/** Plain http to a host that is not this computer: the manuscript would travel unencrypted. */
export function needsInsecureConfirm(raw: string): boolean {
  const url = parse(raw.trim())
  return !!url && url.protocol === 'http:' && !isLoopbackHost(url.hostname)
}

/** The scheme, host and port (what an http acceptance is tied to), or '' if not a URL. */
export const originOf = (raw: string | undefined): string => (raw ? (parse(raw.trim())?.origin ?? '') : '')

/** The page's problem with an address, in words, or null (mirrors Rust's `check_base_url`). */
export function baseUrlProblem(raw: string): string | null {
  const text = raw.trim()
  if (!text) return 'Enter the server address, for example http://localhost:11434/v1.'
  if (/\s/.test(text)) return 'The address cannot contain spaces.'
  const url = parse(text)
  if (!url) return 'The address must start with http:// or https://.'
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'The address must start with http:// or https://.'
  if (!url.hostname) return 'The address has no server name.'
  if (url.username || url.password) return 'Leave the user name and password out of the address.'
  if (text.includes('?') || text.includes('#')) return 'Leave anything after ? or # out of the address.'
  return null
}

/**
 * Tidy an address before it is saved: trim it, drop a trailing slash, and add the adapter's `apiPath`
 * (Ollama's and LM Studio's `/v1`) when only the server was typed (T3: without it every request
 * misses). Anything else is kept as typed.
 */
export function normaliseBaseUrl(apiPath: string | undefined, raw: string): string {
  const text = raw.trim()
  const url = parse(text)
  if (!url || baseUrlProblem(text)) return text
  const path = url.pathname.replace(/\/+$/, '')
  if (apiPath && path === '') return `${url.origin}${apiPath}`
  return `${url.origin}${path}`
}

/**
 * A hint for an address of a server without a known API path (a custom endpoint) that has no version
 * segment: most OpenAI-compatible servers use /v1.
 */
export function baseUrlHint(apiPath: string | undefined, raw: string): string | null {
  if (apiPath) return null
  const url = parse(raw.trim())
  if (!url || baseUrlProblem(raw)) return null
  return /\/v\d+(\/|$)/.test(url.pathname) ? null : 'Most OpenAI-compatible servers end in /v1 (for example https://example.com/v1). Add it if Test Connection finds no models.'
}
