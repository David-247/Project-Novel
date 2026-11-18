import { describe, expect, it } from 'vitest'
import { FIXTURE_MANUSCRIPT_IR } from './fixtures'
import { createMockRenderer } from './mock-renderer'
import { manuscriptPlainText } from './plain-text'
import { assertManuscriptVersion, isAbortError, UnsupportedManuscriptVersionError, type RenderProgress } from './renderer'
import type { ManuscriptIR } from './types'

/** The renderer contract (./renderer.ts), checked on the mock renderer. */

const ir = (): ManuscriptIR => structuredClone(FIXTURE_MANUSCRIPT_IR)

describe('ManuscriptRenderer contract (mock renderer)', () => {
  it('resolves with the bytes, reporting progress from 0 up to 1, and leaves the IR unchanged', async () => {
    const renderer = createMockRenderer()
    const input = ir()
    const progress: RenderProgress[] = []
    const bytes = await renderer.render(input, {}, { onProgress: (p) => progress.push(p) })
    // (jsdom's TextEncoder returns another realm's Uint8Array: check the tag, not instanceof.)
    expect(Object.prototype.toString.call(bytes)).toBe('[object Uint8Array]')
    const text = new TextDecoder().decode(bytes)
    expect(text).toBe(manuscriptPlainText(FIXTURE_MANUSCRIPT_IR, { footnotes: true }))
    expect(text).toContain('Chapter One\nThe Arrival\nIt was night. The rain fell hard and cold.')
    expect(text).toContain('[1] First told in 1902.')
    expect(progress[0].fraction).toBe(0)
    expect(progress.at(-1)!.fraction).toBe(1)
    for (let i = 1; i < progress.length; i++) expect(progress[i].fraction).toBeGreaterThanOrEqual(progress[i - 1].fraction)
    expect(input).toEqual(FIXTURE_MANUSCRIPT_IR)
    expect(renderer.calls).toHaveLength(1)
  })

  it('rejects with an AbortError when cancelled before or during the render', async () => {
    const renderer = createMockRenderer({ delayMs: 5 })
    const before = new AbortController()
    before.abort()
    await expect(renderer.render(ir(), {}, { signal: before.signal })).rejects.toSatisfy(isAbortError)

    const during = new AbortController()
    const run = renderer.render(ir(), {}, { signal: during.signal, onProgress: (p) => p.done === 1 && during.abort() })
    await expect(run).rejects.toSatisfy(isAbortError)
  })

  it('rejects an IR version it does not know', async () => {
    const future = { ...ir(), version: 99 } as unknown as ManuscriptIR
    expect(() => assertManuscriptVersion(future)).toThrow(UnsupportedManuscriptVersionError)
    await expect(createMockRenderer().render(future, {})).rejects.toBeInstanceOf(UnsupportedManuscriptVersionError)
  })
})
