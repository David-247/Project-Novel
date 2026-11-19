import { abortError, throwIfAborted, type ManuscriptIR, type ManuscriptRenderer, type RenderOptions, type RenderProgress } from '../ir'
import { ExportPlatformError, renderPdf, type ExportFontReport, type RenderPdfOptions, type RenderPdfResult, type TypstDiagnostic } from '../platform'
import type { ManuscriptSettings } from '../settings'
import { buildPdfData, PDF_TEMPLATE_ID, type ManuscriptMeta, type PdfData } from './data'
import { fontRoleOf, isKnownFamily } from './metrics'

/**
 * The font of a PDF render. `requested` is the family the settings name (trimmed), not the engine's
 * role font; `substituted` is true when that family is not one the engine sets as such (Times New
 * Roman, Tinos, Liberation Serif, Courier New, Cousine, Liberation Mono), so the PDF uses `family`
 * instead. `source: 'bundled'` when the role font is not installed and the bundled fallback is used.
 */
export interface PdfFontReport extends ExportFontReport {
  substituted: boolean
}

/** What a PDF render produced besides the bytes: for the wizard to name the font actually used. */
export interface PdfRenderReport {
  /** The family the PDF is set in, and whether it differs from the settings' family. */
  font: PdfFontReport
  /** Typst warnings (the PDF was still made). */
  warnings: TypstDiagnostic[]
  /** Size of the PDF, bytes. */
  bytes: number
}

export interface PdfRendererOptions {
  /** The title, contact details, word count and language; a function is read at each render. */
  meta: ManuscriptMeta | (() => ManuscriptMeta)
  /** Use an installed Times New Roman / Courier New when present (default true); else the bundled one. */
  preferInstalledFont?: boolean
  /** Called after each successful render with the font used and Typst's warnings. */
  onReport?: (report: PdfRenderReport) => void
  /** The platform call (tests inject a fake). Default: the Typst sidecar over IPC. */
  render?: (options: RenderPdfOptions) => Promise<RenderPdfResult>
  /** Expected Typst time for the progress estimate, ms per 1,000 blocks (default 600). */
  estimateMsPer1000Blocks?: number
}

export interface PdfRenderer extends ManuscriptRenderer<ManuscriptSettings> {
  /** The report of the last successful render (null before one). */
  readonly lastReport: PdfRenderReport | null
}

/** Typst gives no progress: the bar creeps towards this fraction while it runs, then jumps to 1. */
const TYPST_CEILING = 0.95
const DATA_DONE = 0.1
const TICK_MS = 100

/**
 * The PDF manuscript renderer: the IR and the settings become the data file of the bundled Typst
 * template (`buildPdfData`), and the Typst sidecar renders it, fully offline (src-tauri/src/export).
 * Cancelling (the signal) kills the Typst process; the render then rejects with an `AbortError` and
 * returns no bytes, so the caller writes no file.
 */
export function createPdfRenderer(options: PdfRendererOptions): PdfRenderer {
  const run = options.render ?? renderPdf
  const perBlock = (options.estimateMsPer1000Blocks ?? 600) / 1000
  let lastReport: PdfRenderReport | null = null

  async function render(ir: ManuscriptIR, settings: ManuscriptSettings, renderOptions: RenderOptions = {}): Promise<Uint8Array> {
    const { signal, onProgress } = renderOptions
    let fraction = 0
    const progress = (p: RenderProgress) => {
      fraction = Math.max(fraction, Math.min(1, p.fraction))
      onProgress?.({ ...p, fraction })
    }
    throwIfAborted(signal)
    progress({ fraction: 0, stage: 'data' })
    const meta = typeof options.meta === 'function' ? options.meta() : options.meta
    const data: PdfData = buildPdfData(ir, settings, meta)
    throwIfAborted(signal)
    progress({ fraction: DATA_DONE, stage: 'data' })

    const estimate = Math.max(500, data.blocks.length * perBlock)
    const started = Date.now()
    const timer = setInterval(() => {
      // Approaches the ceiling, never reaches it: 63 % of the way at the estimate, 86 % at twice it.
      const t = (Date.now() - started) / estimate
      progress({ fraction: DATA_DONE + (TYPST_CEILING - DATA_DONE) * (1 - Math.exp(-t)), stage: 'typst' })
    }, TICK_MS)
    let result: RenderPdfResult
    try {
      result = await run({
        template: PDF_TEMPLATE_ID,
        data,
        font: fontRoleOf(settings.fontFamily),
        preferInstalledFont: options.preferInstalledFont ?? true,
        signal,
      })
    } catch (e) {
      if (signal?.aborted || (e instanceof ExportPlatformError && e.kind === 'cancelled')) throw abortError()
      throw e
    } finally {
      clearInterval(timer)
    }
    throwIfAborted(signal)
    if (!result.pdf) throw new ExportPlatformError('io', 'The PDF engine returned no file.')
    const requested = settings.fontFamily.trim() || result.font.requested
    const substituted = !isKnownFamily(requested)
    lastReport = { font: { ...result.font, requested, substituted }, warnings: result.warnings, bytes: result.bytes }
    options.onReport?.(lastReport)
    progress({ fraction: 1, stage: 'typst' })
    return result.pdf
  }

  return {
    format: 'pdf',
    mimeType: 'application/pdf',
    fileExtension: 'pdf',
    render,
    get lastReport() {
      return lastReport
    },
  }
}
