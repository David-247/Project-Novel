/**
 * TEST-ONLY stand-in for the Rust export platform commands (src-tauri/src/export), part of the fake
 * Tauri core (./fake-tauri-core.ts) used by Vitest and the e2e backend. It mirrors Rust's rules:
 * writes only to a path picked in the (fake) Save dialog, by token and kind; renders registered
 * before anything else so a cancel is never lost; reveal only for files it exported. The render
 * returns a stub PDF (no Typst in the browser).
 */

export const EXPORT_COMMAND_NAMES = [
  'export_pick_save_path',
  'export_write_file',
  'export_render_pdf',
  'export_cancel_render',
  'export_reveal_in_folder',
  'export_open_file',
] as const

type Kind = 'pdf' | 'docx'

interface ExportFakeError {
  kind: string
  message: string
  diagnostics: unknown[]
}

const fail = (kind: string, message: string): ExportFakeError => ({ kind, message, diagnostics: [] })

/** The stub PDF every fake render produces. */
export const FAKE_PDF = new TextEncoder().encode('%PDF-1.7\n% Novel fake export\n%%EOF\n')

const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))

/** The folder of a POSIX path ('/a/b.pdf' -> '/a'). */
const folderOf = (p: string) => p.slice(0, p.lastIndexOf('/')) || '/'

/**
 * `activeRoot`: the open project's root (Rust's ProjectRoot), the key of Rust's record of the last
 * export folder per project (export-folders.json in the app data dir).
 */
export function createFakeExport(installedFonts: () => readonly string[], activeRoot: () => string | null = () => null) {
  const state = {
    /** Save dialog answer: undefined = `/exports/<default name>`, null = cancelled, else that path. */
    savePath: undefined as string | null | undefined,
    /** Save-dialog grants, each with the project open when it was picked ('' = none). */
    picks: [] as { token: string; path: string; kind: Kind; project: string }[],
    nextToken: 0,
    /** Files written by export_write_file or a render with an output token, by path. */
    written: new Map<string, Uint8Array>(),
    /** Every export_render_pdf request, in order. */
    renders: [] as Record<string, unknown>[],
    /** Each render takes this long (so tests can cancel it). */
    renderDelayMs: 0,
    /** Thrown by the next renders (e.g. a compile error with diagnostics). */
    failRender: null as ExportFakeError | null,
    /** Running renders: job id -> cancel. */
    running: new Map<string, () => void>(),
    cancels: [] as string[],
    reveals: [] as string[],
    opens: [] as string[],
    /** Every Save dialog shown: its kind, default name and the starting folder Rust chose. */
    dialogs: [] as { kind: Kind; defaultName: string; directory: string | null }[],
    /** Thrown by the next export_write_file calls (e.g. `{ kind: 'disk_full', ... }`). */
    failWrite: null as ExportFakeError | null,
    /** Only writes whose path contains this fail with `failWrite` (null: every write). */
    failWriteMatch: null as string | null,
    /** Thrown by the next Save dialogs (the dialog plugin failing). */
    failPick: null as ExportFakeError | null,
    /** Rust's export-folders.json: project root ('' = none) -> folder of its last export. Survives a restart. */
    remembered: new Map<string, string>(),
  }

  /** A relaunch of the app: Rust forgets its Save-dialog grants and exported files; its files on disk stay. */
  function restartSession() {
    state.picks = []
  }

  /**
   * Where Rust opens the Save dialog (files::dialog_start): the folder of the open project's most recent
   * grant this session (any kind; another project's grants never count), else its remembered folder.
   */
  function dialogStart(): string | null {
    const project = activeRoot() ?? ''
    const last = [...state.picks].reverse().find((p) => p.project === project)
    if (last) return folderOf(last.path)
    return state.remembered.get(project) ?? null
  }

  function reset() {
    state.savePath = undefined
    state.picks = []
    state.nextToken = 0
    state.written.clear()
    state.renders = []
    state.renderDelayMs = 0
    state.failRender = null
    state.running.clear()
    state.cancels = []
    state.reveals = []
    state.opens = []
    state.dialogs = []
    state.failWrite = null
    state.failWriteMatch = null
    state.failPick = null
    state.remembered.clear()
  }

  const safeName = (name: string, kind: Kind) => {
    const base = name.replace(/[/\\:*?"<>|]/g, '_').trim() || 'Manuscript'
    return base.toLowerCase().endsWith(`.${kind}`) ? base : `${base}.${kind}`
  }

  function target(token: unknown, kind: Kind): string {
    const pick = state.picks.find((p) => p.token === token && p.kind === kind)
    if (!pick) throw fail('invalid_token', 'Choose where to save the file first (the Save dialog was not used).')
    return pick.path
  }

  function fontReport(role: unknown, preferInstalled: boolean) {
    const serif = role !== 'mono'
    const requested = serif ? 'Times New Roman' : 'Courier New'
    const bundled = serif ? 'Liberation Serif' : 'Liberation Mono'
    const system = preferInstalled && installedFonts().some((f) => f.toLowerCase() === requested.toLowerCase())
    const family = system ? requested : bundled
    return { requested, family, source: system ? 'system' : 'bundled', embedded: [family.replace(/ /g, '')] }
  }

  async function handle(cmd: string, args: unknown, options?: { headers?: unknown }): Promise<unknown> {
    const a = (args ?? {}) as Record<string, unknown>
    switch (cmd) {
      case 'export_pick_save_path': {
        const kind = a.kind === 'docx' ? 'docx' : 'pdf'
        if ('directory' in a) throw fail('invalid_request', 'The webview names no folder for the Save dialog.')
        if (state.failPick) throw state.failPick
        state.dialogs.push({ kind, defaultName: String(a.defaultName ?? ''), directory: dialogStart() })
        const path =
          state.savePath === undefined ? `/exports/${safeName(String(a.defaultName ?? ''), kind)}` : state.savePath
        if (path === null) return null
        state.nextToken += 1
        const token = `export-${state.nextToken}`
        state.picks.push({ token, path, kind, project: activeRoot() ?? '' })
        return { token, path }
      }
      case 'export_write_file': {
        // Any realm's Uint8Array (jsdom tests get Node's from TextEncoder).
        const isBytes = args instanceof Uint8Array || Object.prototype.toString.call(args) === '[object Uint8Array]'
        if (!isBytes) throw fail('invalid_request', 'Expected the file bytes as the raw request body.')
        const body = args as Uint8Array
        // mockIPC drops invoke options (headers): then the latest pick is the target.
        const headers = (options?.headers ?? {}) as Record<string, string>
        const last = state.picks[state.picks.length - 1]
        const token = headers['x-export-token'] ?? last?.token
        const kind = (headers['x-export-kind'] ?? last?.kind) as Kind
        const path = target(token, kind)
        if (state.failWrite && (state.failWriteMatch === null || path.includes(state.failWriteMatch))) throw state.failWrite
        state.written.set(path, Uint8Array.from(body))
        state.remembered.set(activeRoot() ?? '', folderOf(path))
        return { path, bytes: body.length }
      }
      case 'export_render_pdf': {
        const req = (a.request ?? null) as Record<string, unknown> | null
        if (!req || typeof req.jobId !== 'string') throw fail('invalid_request', 'Missing render request.')
        const jobId = req.jobId
        if (state.running.has(jobId)) throw fail('busy', `Export ${jobId} is already running.`)
        let cancelled = false
        state.running.set(jobId, () => (cancelled = true))
        try {
          state.renders.push(req)
          if (typeof req.template !== 'string' || !req.template) throw fail('unknown_template', 'No export template named ""')
          const path = req.outputToken != null ? target(req.outputToken, 'pdf') : null
          const until = Date.now() + state.renderDelayMs
          while (Date.now() < until && !cancelled) await new Promise((r) => setTimeout(r, 10))
          if (cancelled) throw fail('cancelled', 'The export was cancelled.')
          if (state.failRender) throw state.failRender
          const font = fontReport(req.font, req.preferInstalledFont !== false)
          if (path) {
            state.written.set(path, FAKE_PDF.slice())
            state.remembered.set(activeRoot() ?? '', folderOf(path))
            return { font, warnings: [], path, pdfBase64: null, bytes: FAKE_PDF.length }
          }
          return { font, warnings: [], path: null, pdfBase64: toBase64(FAKE_PDF), bytes: FAKE_PDF.length }
        } finally {
          state.running.delete(jobId)
        }
      }
      case 'export_cancel_render': {
        const cancel = state.running.get(String(a.jobId))
        state.cancels.push(String(a.jobId))
        cancel?.()
        return cancel !== undefined
      }
      case 'export_reveal_in_folder': {
        const path = String(a.path)
        if (!state.written.has(path)) throw fail('not_exported', 'Novel only shows files it has just exported.')
        state.reveals.push(path)
        return null
      }
      case 'export_open_file': {
        const path = String(a.path)
        if (!state.written.has(path)) throw fail('not_exported', 'Novel only shows files it has just exported.')
        state.opens.push(path)
        return null
      }
      default:
        throw new Error(`unexpected command ${cmd}`)
    }
  }

  return { state, handle, reset, restartSession }
}
