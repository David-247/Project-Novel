import { invoke } from '@tauri-apps/api/core'

/**
 * Typed wrapper for the export platform commands (src-tauri/src/export): the native Save dialog,
 * atomic export writes, the offline Typst PDF render, cancel, and reveal in folder.
 *
 * The webview never names a path to write: `pickSavePath` shows the Save dialog in Rust and returns
 * a target whose token is the only way to write there. Templates are bundled in Rust and picked by
 * id; the webview sends data (JSON), never Typst source or command-line arguments.
 */

/** Command names (src-tauri/src/export/mod.rs). */
export const EXPORT_COMMANDS = {
  pickSavePath: 'export_pick_save_path',
  writeFile: 'export_write_file',
  renderPdf: 'export_render_pdf',
  cancelRender: 'export_cancel_render',
  revealInFolder: 'export_reveal_in_folder',
  openFile: 'export_open_file',
} as const

/** Headers of the raw-body `export_write_file` call. */
export const EXPORT_HEADERS = { token: 'x-export-token', kind: 'x-export-kind' } as const

export type ExportFileKind = 'pdf' | 'docx'

/** Body font: `serif` = Times New Roman (fallback Liberation Serif), `mono` = Courier New (Liberation Mono). */
export type ExportFontRole = 'serif' | 'mono'

/** A path the user chose in the native Save dialog. */
export interface SaveTarget {
  /** Handle Rust gave the picked path; writes and renders name the target by it. */
  token: string
  /** The chosen path (for display). */
  path: string
  kind: ExportFileKind
}

export type ExportErrorKind =
  | 'package_import'
  | 'unknown_template'
  | 'sidecar_missing'
  | 'spawn'
  | 'compile'
  | 'timeout'
  | 'cancelled'
  | 'busy'
  | 'invalid_request'
  | 'invalid_token'
  | 'not_exported'
  | 'not_found'
  | 'invalid_path'
  | 'symlink'
  | 'disk_full'
  | 'read_only'
  | 'permission_denied'
  | 'io'

/** One Typst diagnostic (error or warning). `file` is "template", "data" or another file name. */
export interface TypstDiagnostic {
  severity: 'error' | 'warning'
  file: string | null
  line: number | null
  column: number | null
  message: string
  hints: string[]
}

/** A failed export command. */
export class ExportPlatformError extends Error {
  readonly kind: ExportErrorKind
  readonly diagnostics: readonly TypstDiagnostic[]
  constructor(kind: ExportErrorKind, message: string, diagnostics: readonly TypstDiagnostic[] = [], options?: ErrorOptions) {
    super(message, options)
    this.name = 'ExportPlatformError'
    this.kind = kind
    this.diagnostics = diagnostics
  }
}

interface RustExportError {
  kind: ExportErrorKind
  message: string
  diagnostics?: TypstDiagnostic[]
}

function isRustError(e: unknown): e is RustExportError {
  return typeof e === 'object' && e !== null && 'kind' in e && 'message' in e
}

/** Run a command, turning a Rust error into an ExportPlatformError. */
async function call<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (e) {
    if (e instanceof ExportPlatformError) throw e
    if (isRustError(e)) throw new ExportPlatformError(e.kind, e.message, e.diagnostics ?? [], { cause: e })
    throw new ExportPlatformError('io', e instanceof Error ? e.message : String(e), [], { cause: e })
  }
}

/**
 * Show the native Save dialog for a PDF or DOCX (with that file type's filter). Returns the chosen
 * target, or null if the user cancelled. Rust chooses the folder it opens in (the last one granted
 * this session, else the project's last export folder it recorded); the webview passes no path.
 */
export async function pickSavePath(
  kind: ExportFileKind,
  defaultName: string,
  title?: string,
): Promise<SaveTarget | null> {
  const picked = await call(() =>
    invoke<{ token: string; path: string } | null>(EXPORT_COMMANDS.pickSavePath, { kind, defaultName, title }),
  )
  return picked ? { ...picked, kind } : null
}

/** A file an export wrote. */
export interface WrittenExport {
  path: string
  bytes: number
}

/**
 * Write export bytes (e.g. a generated DOCX) to a Save-dialog target, atomically: on failure the
 * previous file, or nothing, is left, never a partial file.
 */
export async function writeExportFile(target: SaveTarget, bytes: Uint8Array): Promise<WrittenExport> {
  return call(() =>
    invoke<WrittenExport>(EXPORT_COMMANDS.writeFile, bytes, {
      headers: { [EXPORT_HEADERS.token]: target.token, [EXPORT_HEADERS.kind]: target.kind },
    }),
  )
}

/** Which font the PDF was set in (for the wizard to say so). */
export interface ExportFontReport {
  /** The family manuscripts expect: "Times New Roman" or "Courier New". */
  requested: string
  /** The family actually used. */
  family: string
  /** `system` = the installed font; `bundled` = the metric-compatible fallback shipped with Novel. */
  source: 'system' | 'bundled'
  /** Font names embedded in the PDF, e.g. "TimesNewRomanPSMT", "LiberationSerif-Italic". */
  embedded: string[]
}

export interface RenderPdfOptions {
  /** A bundled template id (src-tauri/src/export/templates.rs). */
  template: string
  /** The template's data (sent as data.json): an object, or JSON text. */
  data: unknown
  font: ExportFontRole
  /** Use an installed Times New Roman / Courier New when present (default true). */
  preferInstalledFont?: boolean
  /** Write the PDF to this Save-dialog target; without one the PDF bytes are returned. */
  target?: SaveTarget
  /** Default 120 s (clamped by Rust to 1 s .. 10 min). */
  timeoutMs?: number
  /** Aborting kills the Typst process; the promise rejects with kind "cancelled". */
  signal?: AbortSignal
}

export interface RenderPdfResult {
  font: ExportFontReport
  /** Typst warnings (the render still succeeded). */
  warnings: TypstDiagnostic[]
  /** Set when the PDF was written to `target`. */
  path?: string
  /** Set when no `target` was given. */
  pdf?: Uint8Array
  bytes: number
}

interface RustRenderResult {
  font: ExportFontReport
  warnings: TypstDiagnostic[]
  path: string | null
  pdfBase64: string | null
  bytes: number
}

let jobCounter = 0

function newJobId(): string {
  jobCounter += 1
  const random = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : String(Math.random())
  return `render-${jobCounter}-${random}`
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** Stop a running render by id. False when no render with that id is running. */
export async function cancelRender(jobId: string): Promise<boolean> {
  return call(() => invoke<boolean>(EXPORT_COMMANDS.cancelRender, { jobId }))
}

/**
 * Safety net only: Rust registers the job before any other work (font scan, token lookup), so a
 * cancel can miss only while the render invoke itself is still in flight to Rust.
 */
const CANCEL_RETRY_MS = 50
const CANCEL_RETRIES = 5

/**
 * Render a bundled template to PDF with the Typst sidecar, fully offline. With a `target` the PDF is
 * written there atomically (and can then be revealed); otherwise its bytes are returned.
 */
export async function renderPdf(options: RenderPdfOptions): Promise<RenderPdfResult> {
  const { signal } = options
  if (signal?.aborted) throw new ExportPlatformError('cancelled', 'The export was cancelled.')
  const jobId = newJobId()
  const data = typeof options.data === 'string' ? options.data : JSON.stringify(options.data)
  let settled = false
  const onAbort = () => {
    // The abort can beat the render invoke to Rust: retry briefly until the job is found.
    void (async () => {
      for (let i = 0; i < CANCEL_RETRIES && !settled; i++) {
        if (await cancelRender(jobId).catch(() => false)) return
        await new Promise((r) => setTimeout(r, CANCEL_RETRY_MS))
      }
    })()
  }
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const r = await call(() =>
      invoke<RustRenderResult>(EXPORT_COMMANDS.renderPdf, {
        request: {
          jobId,
          template: options.template,
          data,
          font: options.font,
          preferInstalledFont: options.preferInstalledFont ?? true,
          outputToken: options.target?.token ?? null,
          timeoutMs: options.timeoutMs ?? null,
        },
      }),
    )
    return {
      font: r.font,
      warnings: r.warnings,
      bytes: r.bytes,
      ...(r.path != null ? { path: r.path } : {}),
      ...(r.pdfBase64 != null ? { pdf: base64ToBytes(r.pdfBase64) } : {}),
    }
  } finally {
    settled = true
    signal?.removeEventListener('abort', onAbort)
  }
}

/** Show an exported file in Explorer / Finder. Rust refuses any path this app did not just export. */
export async function revealInFolder(path: string): Promise<void> {
  await call(() => invoke<null>(EXPORT_COMMANDS.revealInFolder, { path }))
}

/** Open an exported .docx / .pdf in its default app. Rust refuses any path this app did not just export. */
export async function openExportedFile(path: string): Promise<void> {
  await call(() => invoke<null>(EXPORT_COMMANDS.openFile, { path }))
}
