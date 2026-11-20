// @vitest-environment node
import { describe, expect, it } from 'vitest'
// The gate is a plain Node script (scripts/check-provider-isolation.mjs, run by `pnpm lint`); loaded untyped here.
const SCRIPT: string = '../scripts/check-provider-isolation.mjs'
const { check, violations } = (await import(/* @vite-ignore */ SCRIPT)) as {
  check: () => string[]
  violations: (path: string, text: string) => { line: number; rule: string }[]
}

describe('provider isolation gate', () => {
  it('passes on the repository as it is', () => {
    expect(check()).toEqual([])
  })

  it('flags an SDK provider import and a provider host outside the allowed places', () => {
    const sdk = violations('src/features/editor/x.ts', "import { createAnthropic } from '@ai-sdk/anthropic'\n")
    expect(sdk).toHaveLength(1)
    const host = violations('src/shared/x.ts', "const u = 'https://api.openai.com/v1'\n")
    expect(host).toHaveLength(1)
  })

  it('flags branching on a provider id (comparison and case label) outside providers/', () => {
    for (const line of [
      "if (c.provider === 'anthropic') {",
      'if (conn.provider !== "xai") return',
      "const ok = provider === 'custom'",
      "if ('ollama' === c.provider) {",
      "  case 'openrouter':",
    ]) {
      expect(violations('src/features/ai-tutor/chat/x.ts', line), line).toHaveLength(1)
    }
  })

  it('does not flag other uses of a provider id, or branching inside providers/ and tests', () => {
    for (const line of ["const ids = ['anthropic', 'openai']", "if (c.provider === other.provider) {", "case 'other':", "id: 'anthropic',"]) {
      expect(violations('src/features/ai-tutor/chat/x.ts', line), line).toEqual([])
    }
    expect(violations('src/features/ai-tutor/providers/x.ts', "if (c.provider === 'anthropic') {")).toEqual([])
    expect(violations('src/features/ai-tutor/chat/x.test.ts', "if (c.provider === 'anthropic') {")).toEqual([])
    expect(violations('src/test-utils/x.ts', "case 'xai':")).toEqual([])
  })

  it('allows providers/, providers.rs, provider-neutral packages, tests and the id union', () => {
    expect(violations('src/features/ai-tutor/providers/a.ts', "import x from '@ai-sdk/anthropic'")).toEqual([])
    expect(violations('src-tauri/src/ai/providers.rs', 'base_url: "https://api.x.ai/v1"')).toEqual([])
    expect(violations('src/features/ai-tutor/net/a.ts', "import type { X } from '@ai-sdk/provider'")).toEqual([])
    expect(violations('src/features/ai-tutor/net/a.test.ts', "import x from '@ai-sdk/openai-compatible'")).toEqual([])
    expect(violations('src/features/ai-tutor/connections/types.ts', "export const IDS = ['anthropic', 'openai']")).toEqual([])
    expect(violations('src-tauri/src/ai/x.rs', 'fn a() {}\n#[cfg(test)]\nmod t { const H: &str = "https://api.openai.com"; }')).toEqual([])
  })

  it('flags the sign-in and plan hosts too', () => {
    for (const line of [
      'const T: &str = "https://auth.openai.com/oauth/token";',
      'const U: &str = "https://chatgpt.com/";',
      'const B: &str = "https://chatgpt.com/backend-api/codex";',
      'const K: &str = "https://openrouter.ai/api/v1/auth/keys";',
      'const A: &str = "https://openrouter.ai/auth?callback_url=x";',
    ]) {
      expect(violations('src-tauri/src/ai/chatgpt.rs', line), line).toHaveLength(1)
    }
  })

  it('scans Rust code after a #[cfg(test)] item that is not the test module', () => {
    const text = [
      '#[cfg(test)]',
      'pub fn helper() {}',
      'pub fn sign_in() { let u = "https://auth.openai.com/oauth/authorize"; }',
      '#[cfg(test)]',
      'mod tests {',
      '    const H: &str = "https://api.openai.com";',
      '}',
    ].join('\n')
    expect(violations('src-tauri/src/ai/chatgpt.rs', text)).toEqual([{ line: 3, rule: 'provider API host outside providers/ and providers.rs' }])
  })
})
