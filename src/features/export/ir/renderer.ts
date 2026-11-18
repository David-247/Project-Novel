import { MANUSCRIPT_IR_VERSION, type ManuscriptIR } from './types'

/**
 * The renderer contract (docs/manuscript-ir.md): every export format (the DOCX generator, the PDF
 * generator through the Typst sidecar; EPUB later) implements `ManuscriptRenderer`, so the export
 * wizard drives them the same way.
 */

/**
 * PLACEHOLDER, replaced at merge: the export settings type (`ManuscriptSettings`) is written by the
 * research-and-settings ticket in parallel. Renderers are generic over their settings, so the merge
 * only changes the default type argument below; no field is assumed here.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface ManuscriptSettingsPlaceholder {}

export type ExportFormat = 'docx' | 'pdf' | 'text'

export interface RenderProgress {
  /** 0 to 1, never decreasing within one render; the last report before the promise resolves is 1. */
  fraction: number
  /** Optional work units behind `fraction` (e.g. chapters written of total). */
  done?: number
  total?: number
  /** Short stage name for logs ("chapters", "footnotes", "typst"); not shown to the user as is. */
  stage?: string
}

export interface RenderOptions {
  /**
   * Cancels the render. A renderer checks it before starting and between units of work, and then
   * rejects with an `AbortError` (`abortError()`), writing nothing.
   */
  signal?: AbortSignal
  /** Progress reports (throttling is the caller's business; a renderer may call it often). */
  onProgress?: (progress: RenderProgress) => void
}

/**
 * A manuscript renderer. Rules every implementation keeps (tests: ./renderer.test.ts runs them on the
 * mock):
 * - `render` never mutates `ir` or `settings`, and makes no network call (the app is offline).
 * - It rejects with `UnsupportedManuscriptVersionError` for an IR version it does not know
 *   (`assertManuscriptVersion`), and with an `AbortError` once `signal` is aborted.
 * - It resolves with the complete file's bytes; writing them to disk is the caller's job.
 */
export interface ManuscriptRenderer<TSettings = ManuscriptSettingsPlaceholder> {
  readonly format: ExportFormat
  /** e.g. 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'. */
  readonly mimeType: string
  /** Without the dot: 'docx', 'pdf', 'txt'. */
  readonly fileExtension: string
  render(ir: ManuscriptIR, settings: TSettings, options?: RenderOptions): Promise<Uint8Array>
}

export class UnsupportedManuscriptVersionError extends Error {
  constructor(readonly version: unknown) {
    super(`Unsupported manuscript IR version ${String(version)} (this build reads version ${MANUSCRIPT_IR_VERSION}).`)
    this.name = 'UnsupportedManuscriptVersionError'
  }
}

/** Throws `UnsupportedManuscriptVersionError` unless `ir` is the version this build writes. */
export function assertManuscriptVersion(ir: Pick<ManuscriptIR, 'version'>): void {
  if (ir.version !== MANUSCRIPT_IR_VERSION) throw new UnsupportedManuscriptVersionError(ir.version)
}

/** The error a cancelled render rejects with (a DOMException named 'AbortError', as fetch uses). */
export function abortError(): DOMException {
  return new DOMException('The export was cancelled.', 'AbortError')
}

export function isAbortError(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'AbortError'
}

/** Throws `abortError()` when `signal` is aborted. */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError()
}
