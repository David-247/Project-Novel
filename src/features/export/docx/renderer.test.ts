import { afterEach, describe, expect, it, vi } from 'vitest'
import { FIXTURE_MANUSCRIPT_IR } from '../ir/fixtures'
import { isAbortError, UnsupportedManuscriptVersionError, type RenderProgress } from '../ir/renderer'
import type { ManuscriptIR } from '../ir/types'
import { renderDocx } from './build'
import type { DocxWorkerRequest, DocxWorkerResponse } from './protocol'
import { createDocxRenderer } from './renderer'
import { testSettings, unzipDocx } from './test-helpers'
import { DOCX_MIME_TYPE } from './types'

// The renderer contract (docs/manuscript-ir.md, ../ir/renderer.ts) for the DOCX renderer, in the page
// and through a worker (a fake one here: Vitest has no Worker; the real one runs in e2e).

const settings = testSettings()

/** A Worker that runs the real build in this thread, as ./worker.ts does. */
class FakeWorker {
  onmessage: ((e: MessageEvent<DocxWorkerResponse>) => void) | null = null
  onerror: ((e: ErrorEvent) => void) | null = null
  onmessageerror: ((e: MessageEvent) => void) | null = null
  terminated = false
  /** `fail`: an error event with this message (or a messageerror for 'messageerror'), optionally after one progress report. */
  constructor(
    private readonly fail?: string,
    private readonly afterProgress = false,
  ) {}
  postMessage(msg: DocxWorkerRequest) {
    const post = (data: DocxWorkerResponse) => !this.terminated && this.onmessage?.({ data } as MessageEvent<DocxWorkerResponse>)
    if (this.fail) {
      const fail = this.fail
      setTimeout(() => {
        if (this.afterProgress) post({ type: 'progress', progress: { fraction: 0, stage: 'chapters' } })
        if (fail === 'messageerror') this.onmessageerror?.({} as MessageEvent)
        else this.onerror?.({ message: fail, preventDefault() {} } as ErrorEvent)
      }, 0)
      return
    }
    void renderDocx(msg.ir, msg.settings, { onProgress: (progress) => post({ type: 'progress', progress }), pause: () => new Promise((r) => setTimeout(r, 1)) })
      .then((bytes) => post({ type: 'done', bytes }))
      .catch((e: Error) => post({ type: 'error', name: e.name, message: e.message }))
  }
  terminate() {
    this.terminated = true
  }
}

const modes = [
  ['in the page', () => createDocxRenderer({ worker: 'never' })],
  ['in a worker', () => createDocxRenderer({ worker: () => new FakeWorker() as unknown as Worker })],
] as const

describe.each(modes)('DOCX renderer %s', (_name, make) => {
  it('declares the format', () => {
    const r = make()
    expect([r.format, r.mimeType, r.fileExtension]).toEqual(['docx', DOCX_MIME_TYPE, 'docx'])
  })

  it('resolves with a .docx (a zip with the document)', async () => {
    const bytes = await make().render(FIXTURE_MANUSCRIPT_IR, settings)
    expect([bytes[0], bytes[1]]).toEqual([0x50, 0x4b]) // "PK"
    expect(unzipDocx(bytes)['word/document.xml']).toContain('Nobody came.')
  })

  it('reports progress from 0 to 1, never going back, 1 last', async () => {
    const seen: RenderProgress[] = []
    await make().render(FIXTURE_MANUSCRIPT_IR, settings, { onProgress: (p) => seen.push(p) })
    expect(seen[0].fraction).toBe(0)
    expect(seen[seen.length - 1].fraction).toBe(1)
    for (let i = 1; i < seen.length; i++) expect(seen[i].fraction).toBeGreaterThanOrEqual(seen[i - 1].fraction)
    expect(seen.some((p) => p.stage === 'chapters' && p.fraction > 0 && p.fraction < 1)).toBe(true)
  })

  it('rejects an unknown IR version', async () => {
    await expect(make().render({ ...FIXTURE_MANUSCRIPT_IR, version: 99 } as unknown as ManuscriptIR, settings)).rejects.toBeInstanceOf(UnsupportedManuscriptVersionError)
  })

  it('rejects with an AbortError when cancelled before starting', async () => {
    const ac = new AbortController()
    ac.abort()
    const e = await make().render(FIXTURE_MANUSCRIPT_IR, settings, { signal: ac.signal }).catch((x: unknown) => x)
    expect(isAbortError(e)).toBe(true)
  })

  it('cancelling mid-render rejects with an AbortError and returns no bytes', async () => {
    const ac = new AbortController()
    let callsAtAbort = -1
    const onProgress = vi.fn((p: RenderProgress) => {
      if (callsAtAbort < 0 && p.stage === 'chapters' && p.fraction > 0) {
        ac.abort()
        callsAtAbort = onProgress.mock.calls.length
      }
    })
    const e = await make().render(FIXTURE_MANUSCRIPT_IR, settings, { signal: ac.signal, onProgress }).catch((x: unknown) => x)
    expect(isAbortError(e)).toBe(true)
    // Not a single progress call after the cancel, even once the rest of the work would have run.
    await new Promise((r) => setTimeout(r, 50))
    expect(callsAtAbort).toBeGreaterThan(0)
    expect(onProgress).toHaveBeenCalledTimes(callsAtAbort)
  })
})

describe('DOCX renderer worker handling', () => {
  it('terminates the worker when cancelled, and when done', async () => {
    const workers: FakeWorker[] = []
    const r = createDocxRenderer({ worker: () => (workers.push(new FakeWorker()), workers[workers.length - 1]) as unknown as Worker })
    await r.render(FIXTURE_MANUSCRIPT_IR, settings)
    expect(workers[0].terminated).toBe(true)
    const ac = new AbortController()
    const pending = r.render(FIXTURE_MANUSCRIPT_IR, settings, { signal: ac.signal })
    ac.abort()
    expect(isAbortError(await pending.catch((x: unknown) => x))).toBe(true)
    expect(workers[1].terminated).toBe(true)
  })

  it('a worker failure rejects the render', async () => {
    const r = createDocxRenderer({ worker: () => new FakeWorker('boom') as unknown as Worker })
    await expect(r.render(FIXTURE_MANUSCRIPT_IR, settings)).rejects.toThrow(/DOCX export worker failed: boom/)
  })

  it('a messageerror rejects the render', async () => {
    const r = createDocxRenderer({ worker: () => new FakeWorker('messageerror') as unknown as Worker })
    await expect(r.render(FIXTURE_MANUSCRIPT_IR, settings)).rejects.toThrow(/could not be read/)
  })

  it("'auto' builds in the page where there is no Worker (Vitest)", async () => {
    expect(typeof Worker).toBe('undefined')
    const bytes = await createDocxRenderer().render(FIXTURE_MANUSCRIPT_IR, settings)
    expect(bytes.length).toBeGreaterThan(1000)
  })

  describe("'auto' with a worker that fails", () => {
    const created: FakeWorker[] = []
    const stub = (fail: string, afterProgress = false) =>
      vi.stubGlobal(
        'Worker',
        class extends FakeWorker {
          constructor() {
            super(fail, afterProgress)
            created.push(this)
          }
        },
      )
    afterEach(() => {
      vi.unstubAllGlobals()
      created.length = 0
    })

    it.each(['load failed', 'messageerror'])('before any progress (%s): falls back to the page', async (fail) => {
      stub(fail)
      const bytes = await createDocxRenderer().render(FIXTURE_MANUSCRIPT_IR, settings)
      expect(created).toHaveLength(1)
      expect(created[0].terminated).toBe(true)
      expect(unzipDocx(bytes)['word/document.xml']).toContain('Nobody came.')
    })

    it('after progress: rejects (no second build)', async () => {
      stub('crashed', true)
      await expect(createDocxRenderer().render(FIXTURE_MANUSCRIPT_IR, settings)).rejects.toThrow(/DOCX export worker failed: crashed/)
    })

    it('cancelled while the worker fails: no fallback build', async () => {
      stub('load failed')
      const ac = new AbortController()
      const pending = createDocxRenderer().render(FIXTURE_MANUSCRIPT_IR, settings, { signal: ac.signal })
      ac.abort()
      expect(isAbortError(await pending.catch((x: unknown) => x))).toBe(true)
    })
  })
})
