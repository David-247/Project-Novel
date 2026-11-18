import { afterEach, describe, expect, it, vi } from 'vitest'
import { FIXTURE_MANUSCRIPT_IR, isAbortError, UnsupportedManuscriptVersionError, type ManuscriptIR, type RenderProgress } from '../ir'
import { ExportPlatformError, type RenderPdfOptions, type RenderPdfResult } from '../platform'
import { applyPreset, defaultManuscriptSettings } from '../settings'
import { buildPdfData, PDF_TEMPLATE_ID, type ManuscriptMeta } from './data'
import { createPdfRenderer } from './renderer'

const META: ManuscriptMeta = { title: 'The Long Night', contact: { legalName: 'Perry Slaughter', penName: '', address: '', phone: '', email: '', agent: '' } }
const ir = (): ManuscriptIR => structuredClone(FIXTURE_MANUSCRIPT_IR)
const settings = defaultManuscriptSettings('en-US')
const PDF = new Uint8Array([37, 80, 68, 70])
const font = { requested: 'Times New Roman', family: 'Liberation Serif', source: 'bundled' as const, embedded: ['LiberationSerif'] }

/** A fake platform render that resolves after `ms` (or when aborted, like Rust: kind "cancelled"). */
function fakeRender(ms = 0, result: Partial<RenderPdfResult> = {}) {
  const calls: RenderPdfOptions[] = []
  const run = (o: RenderPdfOptions) =>
    new Promise<RenderPdfResult>((resolve, reject) => {
      calls.push(o)
      const timer = setTimeout(() => resolve({ font, warnings: [], bytes: PDF.length, pdf: PDF, ...result }), ms)
      o.signal?.addEventListener('abort', () => {
        clearTimeout(timer)
        reject(new ExportPlatformError('cancelled', 'The export was cancelled.'))
      })
    })
  return { run, calls }
}

afterEach(() => vi.useRealTimers())

describe('createPdfRenderer (ManuscriptRenderer contract)', () => {
  it('sends the template id, the data, the font role; resolves with the PDF and reports the font', async () => {
    const { run, calls } = fakeRender()
    const onReport = vi.fn()
    const renderer = createPdfRenderer({ meta: META, render: run, onReport })
    expect([renderer.format, renderer.mimeType, renderer.fileExtension]).toEqual(['pdf', 'application/pdf', 'pdf'])
    const input = ir()
    const progress: RenderProgress[] = []
    const bytes = await renderer.render(input, settings, { onProgress: (p) => progress.push(p) })
    expect(bytes).toBe(PDF)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ template: PDF_TEMPLATE_ID, font: 'serif', preferInstalledFont: true })
    expect(calls[0].data).toEqual(buildPdfData(FIXTURE_MANUSCRIPT_IR, settings, META))
    expect(onReport).toHaveBeenCalledWith({ font: { ...font, substituted: false }, warnings: [], bytes: 4 })
    expect(renderer.lastReport?.font.source).toBe('bundled')
    expect(progress[0].fraction).toBe(0)
    expect(progress.at(-1)!.fraction).toBe(1)
    for (let i = 1; i < progress.length; i++) expect(progress[i].fraction).toBeGreaterThanOrEqual(progress[i - 1].fraction)
    expect(input).toEqual(FIXTURE_MANUSCRIPT_IR)
  })

  it('the Classic preset (an untrimmed "  Courier New ") renders in the mono role; meta can be a function', async () => {
    const { run, calls } = fakeRender()
    const meta = vi.fn(() => META)
    await createPdfRenderer({ meta, render: run, preferInstalledFont: false }).render(ir(), { ...applyPreset(settings, 'classic'), fontFamily: '  Courier New ' })
    expect(calls[0]).toMatchObject({ font: 'mono', preferInstalledFont: false })
    expect(meta).toHaveBeenCalledOnce()
  })

  it('a family the engine does not set (Garamond) is reported as substituted, with the trimmed name requested', async () => {
    const { run, calls } = fakeRender(0, { font: { requested: 'Times New Roman', family: 'Times New Roman', source: 'system', embedded: ['TimesNewRomanPSMT'] } })
    const renderer = createPdfRenderer({ meta: META, render: run })
    await renderer.render(ir(), { ...settings, fontFamily: '  Garamond ' })
    expect(calls[0].font).toBe('serif')
    expect(renderer.lastReport!.font).toEqual({ requested: 'Garamond', family: 'Times New Roman', source: 'system', embedded: ['TimesNewRomanPSMT'], substituted: true })
    // The known names (any case, untrimmed) are not substitutions.
    for (const f of ['Times New Roman', ' tinos ', 'Liberation Serif', 'Courier New', 'Cousine', 'liberation mono']) {
      await renderer.render(ir(), { ...settings, fontFamily: f })
      expect(renderer.lastReport!.font).toMatchObject({ requested: f.trim(), substituted: false })
    }
  })

  it('progress creeps up while Typst runs, never past 0.95 before the PDF is back', async () => {
    vi.useFakeTimers()
    const { run } = fakeRender(5_000)
    const progress: number[] = []
    const done = createPdfRenderer({ meta: META, render: run, estimateMsPer1000Blocks: 1 }).render(ir(), settings, { onProgress: (p) => progress.push(p.fraction) })
    await vi.advanceTimersByTimeAsync(4_900)
    const during = progress.at(-1)!
    expect(during).toBeGreaterThan(0.5)
    expect(during).toBeLessThan(0.95)
    await vi.advanceTimersByTimeAsync(200)
    await done
    expect(progress.at(-1)).toBe(1)
  })

  it('cancelling kills the render: AbortError, no bytes, no report', async () => {
    const before = new AbortController()
    before.abort()
    const idle = fakeRender()
    await expect(createPdfRenderer({ meta: META, render: idle.run }).render(ir(), settings, { signal: before.signal })).rejects.toSatisfy(isAbortError)
    expect(idle.calls).toHaveLength(0)

    const { run, calls } = fakeRender(1_000)
    const onReport = vi.fn()
    const during = new AbortController()
    const renderer = createPdfRenderer({ meta: META, render: run, onReport })
    const pending = renderer.render(ir(), settings, { signal: during.signal })
    await new Promise((r) => setTimeout(r, 10))
    expect(calls[0].signal).toBe(during.signal)
    during.abort()
    await expect(pending).rejects.toSatisfy(isAbortError)
    expect(onReport).not.toHaveBeenCalled()
    expect(renderer.lastReport).toBeNull()
  })

  it('passes other platform errors on (a compile error keeps its diagnostics)', async () => {
    const diagnostics = [{ severity: 'error' as const, file: 'template', line: 3, column: 1, message: 'boom', hints: [] }]
    const render = () => Promise.reject(new ExportPlatformError('compile', 'boom', diagnostics))
    const err = await createPdfRenderer({ meta: META, render }).render(ir(), settings).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ExportPlatformError)
    expect((err as ExportPlatformError).diagnostics).toEqual(diagnostics)
  })

  it('rejects an IR version it does not know, before calling the engine', async () => {
    const { run, calls } = fakeRender()
    await expect(createPdfRenderer({ meta: META, render: run }).render({ ...ir(), version: 99 } as unknown as ManuscriptIR, settings)).rejects.toBeInstanceOf(UnsupportedManuscriptVersionError)
    expect(calls).toHaveLength(0)
  })
})
