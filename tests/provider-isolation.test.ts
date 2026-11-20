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

  it('allows providers/, providers.rs, provider-neutral packages, tests and the id union', () => {
    expect(violations('src/features/ai-tutor/providers/a.ts', "import x from '@ai-sdk/anthropic'")).toEqual([])
    expect(violations('src-tauri/src/ai/providers.rs', 'base_url: "https://api.x.ai/v1"')).toEqual([])
    expect(violations('src/features/ai-tutor/net/a.ts', "import type { X } from '@ai-sdk/provider'")).toEqual([])
    expect(violations('src/features/ai-tutor/net/a.test.ts', "import x from '@ai-sdk/openai-compatible'")).toEqual([])
    expect(violations('src/features/ai-tutor/connections/types.ts', "export const IDS = ['anthropic', 'openai']")).toEqual([])
    expect(violations('src-tauri/src/ai/x.rs', 'fn a() {}\n#[cfg(test)]\nmod t { const H: &str = "https://api.openai.com"; }')).toEqual([])
  })
})
