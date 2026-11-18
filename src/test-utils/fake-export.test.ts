import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/api/core', async () => (await import('@/test-utils/fake-tauri')).coreModule)

import { core } from '@/test-utils/fake-tauri'
import { pickSavePath, renderPdf, revealInFolder, writeExportFile } from '@/features/export'
import { FAKE_PDF } from './fake-export'

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
