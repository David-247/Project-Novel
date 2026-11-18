import { abortError, assertManuscriptVersion, throwIfAborted, type ManuscriptRenderer, type RenderOptions, type RenderProgress } from '../ir/renderer'
import type { ManuscriptIR } from '../ir/types'
import type { DocxWorkerRequest, DocxWorkerResponse } from './protocol'
import { DOCX_MIME_TYPE, type DocxRenderSettings } from './types'

export interface DocxRendererOptions {
  /**
   * Where the document is built:
   * - 'auto' (default): in a Web Worker when the platform has one, else in the page;
   * - 'never': always in the page (between chapters it yields to the event loop);
   * - a factory: this worker (tests).
   */
  worker?: 'auto' | 'never' | (() => Worker)
}

function createWorker(): Worker | null {
  if (typeof Worker === 'undefined') return null
  try {
    // The literal `new Worker(new URL(...), { type: 'module' })` is what Vite bundles as a worker.
    return new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
  } catch {
    return null
  }
}

const yieldToEventLoop = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

function errorFrom(msg: { name: string; message: string }): Error {
  if (msg.name === 'AbortError') return abortError()
  const e = new Error(msg.message)
  e.name = msg.name
  return e
}

function renderInWorker(worker: Worker, ir: ManuscriptIR, settings: DocxRenderSettings, { signal, onProgress }: RenderOptions): Promise<Uint8Array> {
  return new Promise<Uint8Array>((resolve, reject) => {
    let settled = false
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      worker.terminate()
      fn()
    }
    // Cancel: the worker stops at once (terminated mid-build or mid-zip); nothing is returned.
    const onAbort = () => finish(() => reject(abortError()))
    signal?.addEventListener('abort', onAbort, { once: true })
    worker.onmessage = (e: MessageEvent<DocxWorkerResponse>) => {
      const msg = e.data
      if (settled) return
      if (msg.type === 'progress') onProgress?.(msg.progress)
      else if (msg.type === 'done') finish(() => resolve(msg.bytes))
      else finish(() => reject(errorFrom(msg)))
    }
    worker.onerror = (e: ErrorEvent) => {
      e.preventDefault()
      finish(() => reject(new Error(`The DOCX export worker failed: ${e.message || 'unknown error'}`)))
    }
    const request: DocxWorkerRequest = { type: 'render', ir, settings }
    worker.postMessage(request)
  })
}

/**
 * The DOCX manuscript renderer (`ManuscriptRenderer`, docs/manuscript-ir.md; layout:
 * docs/manuscript-format.md, docs/docx-export.md). `render` resolves with the .docx bytes; the caller
 * writes them (`writeExportFile`). Cancelling rejects with an AbortError and returns no bytes.
 */
export function createDocxRenderer(options: DocxRendererOptions = {}): ManuscriptRenderer<DocxRenderSettings> {
  const mode = options.worker ?? 'auto'
  return {
    format: 'docx',
    mimeType: DOCX_MIME_TYPE,
    fileExtension: 'docx',
    async render(ir, settings, renderOptions = {}) {
      assertManuscriptVersion(ir)
      throwIfAborted(renderOptions.signal)
      // Progress never goes back, whichever side reports it.
      let last = 0
      const onProgress = renderOptions.onProgress
        ? (p: RenderProgress) => {
            if (renderOptions.signal?.aborted) return
            last = Math.max(last, p.fraction)
            renderOptions.onProgress!({ ...p, fraction: last })
          }
        : undefined
      const worker = mode === 'never' ? null : mode === 'auto' ? createWorker() : mode()
      if (worker) return renderInWorker(worker, ir, settings, { signal: renderOptions.signal, onProgress })
      // Loaded on demand: the `docx` library stays out of the app's main bundle (the worker has its own copy).
      const { renderDocx } = await import('./build')
      return renderDocx(ir, settings, { signal: renderOptions.signal, onProgress, pause: yieldToEventLoop })
    },
  }
}
