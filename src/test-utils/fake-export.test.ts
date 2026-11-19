import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/api/core', async () => (await import('@/test-utils/fake-tauri')).coreModule)

import { core } from '@/test-utils/fake-tauri'
import { openExportedFile, pickSavePath, renderPdf, revealInFolder, writeExportFile } from '@/features/export'
import { FAKE_MAX_EXPORTED, FAKE_MAX_PICKED, FAKE_PDF } from './fake-export'

// The export platform wrapper running against the fake core (the path Wave 2's tests use).
beforeEach(() => core.reset())

describe('fake export platform', () => {
  it('Save dialog -> write -> reveal, with Rust rules (token, kind, exported-only reveal)', async () => {
    const target = await pickSavePath('docx', 'My Novel')
    expect(target).toEqual({ token: 'export-1', path: '/exports/My Novel.docx', kind: 'docx' })
    const bytes = new Uint8Array([80, 75, 3, 4])
    expect(await writeExportFile(target!, bytes)).toEqual({ path: '/exports/My Novel.docx', bytes: 4 })
    expect(Array.from(core.exports.written.get('/exports/My Novel.docx')!)).toEqual([80, 75, 3, 4])
    await revealInFolder('/exports/My Novel.docx')
    expect(core.exports.reveals).toEqual(['/exports/My Novel.docx'])
    await expect(revealInFolder('/etc/passwd')).rejects.toMatchObject({ kind: 'not_exported' })
    await expect(writeExportFile({ ...target!, kind: 'pdf' }, bytes)).rejects.toMatchObject({ kind: 'invalid_token' })
  })

  it('B-M5: as strict as Rust: a write without its token and kind headers is refused (no "latest pick" fallback)', async () => {
    await pickSavePath('docx', 'My Novel')
    await expect(core.handle('export_write_file', new Uint8Array([1]) as never)).rejects.toMatchObject({ kind: 'invalid_request' })
    await expect(core.handle('export_write_file', new Uint8Array([1]) as never, { headers: { 'x-export-kind': 'docx' } })).rejects.toMatchObject({ kind: 'invalid_token' })
    expect(core.exports.written.size).toBe(0)
  })

  it('B-M5: after a restart, reveal and open refuse the files of the earlier session (Rust forgets its list)', async () => {
    const t = (await pickSavePath('docx', 'Book'))!
    await writeExportFile(t, new Uint8Array([1]))
    await revealInFolder('/exports/Book.docx')
    core.restartExportSession()
    expect(core.exports.written.has('/exports/Book.docx')).toBe(true)
    await expect(revealInFolder('/exports/Book.docx')).rejects.toMatchObject({ kind: 'not_exported' })
    await expect(openExportedFile('/exports/Book.docx')).rejects.toMatchObject({ kind: 'not_exported' })
  })

  it("B-M5/A-M3: the Save dialog path always ends in the kind's extension, like Rust with_extension", async () => {
    core.exports.savePath = '/exports/notes.txt'
    const txt = (await pickSavePath('docx', 'x'))!
    expect(txt.path).toBe('/exports/notes.txt.docx')
    await writeExportFile(txt, new Uint8Array([1]))
    await openExportedFile('/exports/notes.txt.docx')
    await expect(openExportedFile('/exports/notes.txt')).rejects.toMatchObject({ kind: 'not_exported' })
    core.exports.savePath = '/exports/Draft v1.2'
    expect((await pickSavePath('pdf', 'x'))!.path).toBe('/exports/Draft v1.2.pdf')
    core.exports.savePath = '/exports/Book.PDF'
    expect((await pickSavePath('pdf', 'x'))!.path).toBe('/exports/Book.PDF')
    core.exports.savePath = '/exports/Book.'
    expect((await pickSavePath('pdf', 'x'))!.path).toBe('/exports/Book.pdf')
    core.exports.savePath = '/exports/Final'
    expect((await pickSavePath('pdf', 'x'))!.path).toBe('/exports/Final.pdf')
    core.exports.savePath = '/exports/.hidden'
    expect((await pickSavePath('pdf', 'x'))!.path).toBe('/exports/.hidden.pdf')
  })

  it('B-M5: grants and the exported list are capped like Rust (16 and 32)', async () => {
    const first = (await pickSavePath('docx', 'First'))!
    for (let i = 0; i < FAKE_MAX_PICKED; i++) await pickSavePath('docx', `More ${i}`)
    await expect(writeExportFile(first, new Uint8Array([1]))).rejects.toMatchObject({ kind: 'invalid_token' })
    core.reset()
    for (let i = 0; i <= FAKE_MAX_EXPORTED; i++) await writeExportFile((await pickSavePath('pdf', `F${i}`))!, new Uint8Array([1]))
    await expect(revealInFolder('/exports/F0.pdf')).rejects.toMatchObject({ kind: 'not_exported' })
    await revealInFolder(`/exports/F${FAKE_MAX_EXPORTED}.pdf`)
  })

  it('B-M5: the Save dialog starts in the last folder only while it exists (Rust start_directory)', async () => {
    core.exports.savePath = '/books/Night.docx'
    await pickSavePath('docx', 'a')
    await pickSavePath('pdf', 'b')
    core.exports.missingFolders.add('/books')
    await pickSavePath('pdf', 'c')
    expect(core.exports.dialogs.map((d) => d.directory)).toEqual([null, '/books', null])
  })

  it('a cancelled Save dialog returns null', async () => {
    core.exports.savePath = null
    expect(await pickSavePath('pdf', 'x')).toBeNull()
  })

  it('renders a stub PDF to bytes or to the picked path, reporting the font', async () => {
    const r = await renderPdf({ template: 'hello', data: { title: 'Hi' }, font: 'serif' })
    expect(Array.from(r.pdf!)).toEqual(Array.from(FAKE_PDF))
    expect(r.font).toMatchObject({ requested: 'Times New Roman', family: 'Liberation Serif', source: 'bundled' })
    core.state.fonts = ['Times New Roman']
    const target = (await pickSavePath('pdf', 'Book'))!
    const w = await renderPdf({ template: 'hello', data: {}, font: 'serif', target })
    expect(w).toMatchObject({ path: '/exports/Book.pdf', font: { family: 'Times New Roman', source: 'system' } })
    expect(Array.from(core.exports.written.get('/exports/Book.pdf')!)).toEqual(Array.from(FAKE_PDF))
    await revealInFolder('/exports/Book.pdf')
  })

  it('aborting a slow render cancels it and writes nothing', async () => {
    core.exports.renderDelayMs = 5_000
    const target = (await pickSavePath('pdf', 'Book'))!
    const ac = new AbortController()
    const p = renderPdf({ template: 'hello', data: {}, font: 'serif', target, signal: ac.signal })
    ac.abort()
    await expect(p).rejects.toMatchObject({ kind: 'cancelled' })
    expect(core.exports.written.size).toBe(0)
    expect(core.exports.running.size).toBe(0)
  })
})
