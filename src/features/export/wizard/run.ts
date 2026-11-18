import { isAbortError, throwIfAborted, type RenderProgress } from '../ir'
import { ExportPlatformError, writeExportFile, type ExportErrorKind, type SaveTarget, type TypstDiagnostic } from '../platform'
import type { ExportJob, ExportRenderer, WizardFormat } from './renderers'

/**
 * Run one export: render every chosen format to bytes, then write them to their Save-dialog targets.
 * Nothing is written until every render succeeded, and each write is atomic (Rust: temp file +
 * rename), so a cancel or a failure never leaves a partial file. Cancelling is possible until the
 * writes start (they take milliseconds); `onPhase('saving')` says when that is.
 */

export interface WrittenFile {
  format: WizardFormat
  path: string
  bytes: number
}

export interface RunProgress {
  /** 0 to 1 over the whole export (renders, then writes). */
  fraction: number
  format: WizardFormat
  stage: 'render' | 'save'
}

export interface RunOptions {
  signal?: AbortSignal
  onProgress?: (p: RunProgress) => void
}

/** What went wrong, in the user's terms, and what can be done. */
export type ExportProblem = 'cancelled' | 'permission' | 'disk-full' | 'missing-folder' | 'not-granted' | 'typst' | 'render' | 'other'

export class ExportRunError extends Error {
  readonly problem: ExportProblem
  readonly format: WizardFormat
  readonly kind: ExportErrorKind | null
  readonly diagnostics: readonly TypstDiagnostic[]
  /** Choosing another place in the Save dialog may help (permissions, a full disk, a folder gone). */
  readonly changeLocation: boolean
  constructor(problem: ExportProblem, format: WizardFormat, message: string, opts: { kind?: ExportErrorKind | null; diagnostics?: readonly TypstDiagnostic[]; cause?: unknown } = {}) {
    super(message, { cause: opts.cause })
    this.name = 'ExportRunError'
    this.problem = problem
    this.format = format
    this.kind = opts.kind ?? null
    this.diagnostics = opts.diagnostics ?? []
    this.changeLocation = problem === 'permission' || problem === 'disk-full' || problem === 'missing-folder' || problem === 'not-granted'
  }
}

const LABEL: Record<WizardFormat, string> = { docx: 'Word (DOCX) file', pdf: 'PDF' }
const TYPST_KINDS = new Set<ExportErrorKind>(['package_import', 'unknown_template', 'sidecar_missing', 'spawn', 'compile', 'timeout', 'busy', 'invalid_request'])

/** The user-facing error for a failed render or write of `format`. */
export function describeExportError(e: unknown, format: WizardFormat, stage: 'render' | 'save'): ExportRunError {
  if (e instanceof ExportRunError) return e
  const label = LABEL[format]
  if (isAbortError(e) || (e instanceof ExportPlatformError && e.kind === 'cancelled')) {
    return new ExportRunError('cancelled', format, 'The export was cancelled. No file was written.', { cause: e })
  }
  if (e instanceof ExportPlatformError) {
    const kind = e.kind
    const opts = { kind, diagnostics: e.diagnostics, cause: e }
    if (kind === 'permission_denied' || kind === 'read_only' || kind === 'symlink')
      return new ExportRunError('permission', format, `Novel is not allowed to save the ${label} there. Choose another folder, or check that the file is not open in another program.`, opts)
    if (kind === 'disk_full') return new ExportRunError('disk-full', format, `The disk is full, so the ${label} could not be saved. Free some space, or choose another drive.`, opts)
    if (kind === 'not_found' || kind === 'invalid_path')
      return new ExportRunError('missing-folder', format, `The folder chosen for the ${label} no longer exists. Choose another place to save it.`, opts)
    if (kind === 'invalid_token' || kind === 'not_exported')
      return new ExportRunError('not-granted', format, `Choose where to save the ${label} again: Novel can only write to a place you chose in the Save dialog.`, opts)
    if (format === 'pdf' && stage === 'render' && TYPST_KINDS.has(kind)) {
      const first = e.diagnostics.find((d) => d.severity === 'error')?.message ?? e.message
      return new ExportRunError('typst', format, `The PDF could not be made (Typst: ${first}). Try again; if it keeps failing, the manuscript holds something the PDF template cannot set.`, opts)
    }
    return new ExportRunError('other', format, `The ${label} could not be ${stage === 'save' ? 'saved' : 'made'}: ${e.message}`, opts)
  }
  const message = e instanceof Error ? e.message : String(e)
  return new ExportRunError('render', format, `The ${label} could not be made: ${message}`, { cause: e })
}

/**
 * Render `formats` (in order) with their renderers, then write each to its target. Rejects with an
 * `ExportRunError` (problem 'cancelled' after `signal` aborts); resolves with the files written.
 */
export async function runExport(
  job: ExportJob,
  formats: readonly WizardFormat[],
  targets: Partial<Record<WizardFormat, SaveTarget>>,
  renderers: Partial<Record<WizardFormat, ExportRenderer>>,
  { signal, onProgress }: RunOptions = {},
): Promise<WrittenFile[]> {
  const share = 0.95 / Math.max(1, formats.length)
  const rendered: { format: WizardFormat; bytes: Uint8Array; target: SaveTarget }[] = []
  for (const [i, format] of formats.entries()) {
    const renderer = renderers[format]
    const target = targets[format]
    if (!renderer) throw new ExportRunError('render', format, `This build of Novel cannot make a ${LABEL[format]} yet.`)
    if (!target) throw new ExportRunError('not-granted', format, `Choose where to save the ${LABEL[format]}.`)
    try {
      throwIfAborted(signal)
      onProgress?.({ fraction: i * share, format, stage: 'render' })
      const bytes = await renderer.render(job, {
        signal,
        onProgress: (p: RenderProgress) => onProgress?.({ fraction: (i + Math.min(1, Math.max(0, p.fraction))) * share, format, stage: 'render' }),
      })
      throwIfAborted(signal)
      rendered.push({ format, bytes, target })
    } catch (e) {
      throw describeExportError(e, format, 'render')
    }
  }
  const written: WrittenFile[] = []
  for (const { format, bytes, target } of rendered) {
    try {
      // The last chance to cancel: after the first write the export completes.
      if (!written.length) throwIfAborted(signal)
      onProgress?.({ fraction: 0.95 + (0.05 * written.length) / rendered.length, format, stage: 'save' })
      const w = await writeExportFile(target, bytes)
      written.push({ format, path: w.path, bytes: w.bytes })
    } catch (e) {
      throw describeExportError(e, format, 'save')
    }
  }
  onProgress?.({ fraction: 1, format: rendered[rendered.length - 1]?.format ?? 'docx', stage: 'save' })
  return written
}
