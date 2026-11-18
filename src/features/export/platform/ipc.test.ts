import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }))

import {
  base64ToBytes,
  EXPORT_COMMANDS,
  ExportPlatformError,
  openExportedFile,
  pickSavePath,
  renderPdf,
  revealInFolder,
  writeExportFile,
  type SaveTarget,
} from './index'

const font = { requested: 'Times New Roman', family: 'Liberation Serif', source: 'bundled', embedded: ['LiberationSerif'] }

beforeEach(() => invoke.mockReset())

describe('export platform ipc', () => {
  it('passes the starting folder to the Save dialog only when there is one', async () => {
    invoke.mockResolvedValue(null)
    await pickSavePath('docx', 'Novel', undefined, String.raw`C:\Books`)
    expect(invoke).toHaveBeenLastCalledWith(EXPORT_COMMANDS.pickSavePath, { kind: 'docx', defaultName: 'Novel', title: undefined, directory: String.raw`C:\Books` })
    await pickSavePath('docx', 'Novel', undefined, null)
    expect(invoke).toHaveBeenLastCalledWith(EXPORT_COMMANDS.pickSavePath, { kind: 'docx', defaultName: 'Novel', title: undefined })
  })

  it('opens an exported file through Rust, which refuses others', async () => {
    invoke.mockResolvedValueOnce(null)
    await openExportedFile('/x/a.pdf')
    expect(invoke).toHaveBeenCalledWith(EXPORT_COMMANDS.openFile, { path: '/x/a.pdf' })
    invoke.mockRejectedValueOnce({ kind: 'not_exported', message: 'Novel only shows files it has just exported.' })
    await expect(openExportedFile('/etc/passwd')).rejects.toMatchObject({ kind: 'not_exported' })
  })

  it('picks a save path in Rust and keeps the kind with the token', async () => {
    invoke.mockResolvedValueOnce({ token: 'export-1', path: 'C:\\Books\\Novel.pdf' })
    const target = await pickSavePath('pdf', 'Novel', 'Export PDF')
    expect(invoke).toHaveBeenCalledWith(EXPORT_COMMANDS.pickSavePath, {
      kind: 'pdf',
      defaultName: 'Novel',
      title: 'Export PDF',
    })
    expect(target).toEqual({ token: 'export-1', path: 'C:\\Books\\Novel.pdf', kind: 'pdf' })
    invoke.mockResolvedValueOnce(null)
    expect(await pickSavePath('docx', 'Novel')).toBeNull()
  })

  it('writes bytes as the raw body, naming the target by token and kind', async () => {
    const target: SaveTarget = { token: 'export-2', path: '/b/Novel.docx', kind: 'docx' }
    const bytes = new Uint8Array([80, 75, 3, 4])
    invoke.mockResolvedValueOnce({ path: '/b/Novel.docx', bytes: 4 })
    expect(await writeExportFile(target, bytes)).toEqual({ path: '/b/Novel.docx', bytes: 4 })
    expect(invoke).toHaveBeenCalledWith(EXPORT_COMMANDS.writeFile, bytes, {
      headers: { 'x-export-token': 'export-2', 'x-export-kind': 'docx' },
    })
  })

  it('renders to bytes when no target is given', async () => {
    invoke.mockResolvedValueOnce({ font, warnings: [], path: null, pdfBase64: btoa('%PDF-1.7'), bytes: 8 })
    const r = await renderPdf({ template: 'hello', data: { title: 'Hi' }, font: 'serif' })
    const [cmd, args] = invoke.mock.calls[0] as [string, { request: Record<string, unknown> }]
    expect(cmd).toBe(EXPORT_COMMANDS.renderPdf)
    expect(args.request).toMatchObject({
      template: 'hello',
      data: '{"title":"Hi"}',
      font: 'serif',
      preferInstalledFont: true,
      outputToken: null,
      timeoutMs: null,
    })
    expect(typeof args.request.jobId).toBe('string')
    expect(new TextDecoder().decode(r.pdf)).toBe('%PDF-1.7')
    expect(r.path).toBeUndefined()
    expect(r.font).toEqual(font)
  })

  it('renders to a Save-dialog target', async () => {
    invoke.mockResolvedValueOnce({ font, warnings: [], path: '/b/Novel.pdf', pdfBase64: null, bytes: 1200 })
    const target: SaveTarget = { token: 'export-3', path: '/b/Novel.pdf', kind: 'pdf' }
    const r = await renderPdf({ template: 'hello', data: '{}', font: 'mono', target, timeoutMs: 5000, preferInstalledFont: false })
    const [, args] = invoke.mock.calls[0] as [string, { request: Record<string, unknown> }]
    expect(args.request).toMatchObject({ data: '{}', font: 'mono', outputToken: 'export-3', timeoutMs: 5000, preferInstalledFont: false })
    expect(r).toEqual({ font, warnings: [], path: '/b/Novel.pdf', bytes: 1200 })
  })

  it('aborting cancels the Rust job by id', async () => {
    let rejectRender: (e: unknown) => void = () => {}
    invoke.mockImplementation((cmd: string) => {
      if (cmd === EXPORT_COMMANDS.renderPdf) return new Promise((_, rej) => (rejectRender = rej))
      if (cmd === EXPORT_COMMANDS.cancelRender) {
        rejectRender({ kind: 'cancelled', message: 'The export was cancelled.', diagnostics: [] })
        return Promise.resolve(true)
      }
      return Promise.resolve(undefined)
    })
    const ac = new AbortController()
    const p = renderPdf({ template: 'hello', data: {}, font: 'serif', signal: ac.signal })
    ac.abort()
    await expect(p).rejects.toMatchObject({ kind: 'cancelled' })
    const renderId = (invoke.mock.calls[0][1] as { request: { jobId: string } }).request.jobId
    expect(invoke).toHaveBeenCalledWith(EXPORT_COMMANDS.cancelRender, { jobId: renderId })
  })

  it('an already-aborted signal never starts a render', async () => {
    const ac = new AbortController()
    ac.abort()
    await expect(renderPdf({ template: 'hello', data: {}, font: 'serif', signal: ac.signal })).rejects.toMatchObject({
      kind: 'cancelled',
    })
    expect(invoke).not.toHaveBeenCalled()
  })

  it('turns Rust errors into ExportPlatformError with diagnostics', async () => {
    const diag = { severity: 'error', file: 'template', line: 2, column: 1, message: 'unknown variable: foo', hints: [] }
    invoke.mockRejectedValueOnce({ kind: 'compile', message: 'unknown variable: foo', diagnostics: [diag] })
    const err = await renderPdf({ template: 'hello', data: {}, font: 'serif' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ExportPlatformError)
    expect(err).toMatchObject({ kind: 'compile', message: 'unknown variable: foo', diagnostics: [diag] })
    invoke.mockRejectedValueOnce({ kind: 'not_exported', message: 'Novel only shows files it has just exported.' })
    await expect(revealInFolder('/etc/passwd')).rejects.toMatchObject({ kind: 'not_exported', diagnostics: [] })
    expect(invoke).toHaveBeenLastCalledWith(EXPORT_COMMANDS.revealInFolder, { path: '/etc/passwd' })
  })

  it('decodes base64', () => {
    expect(Array.from(base64ToBytes(btoa(String.fromCharCode(0, 255, 37))))).toEqual([0, 255, 37])
  })
})
