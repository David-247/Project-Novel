import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/api/core', async () => (await import('@/test-utils/fake-tauri')).coreModule)

import { backend, core, invokeMock } from '@/test-utils/fake-tauri'
import { buildManuscript, FEATURE_FIXTURE_FOOTNOTES, FEATURE_FIXTURE_STYLES } from '../ir'
import { ExportPlatformError, pickSavePath, type SaveTarget } from '../platform'
import { defaultManuscriptSettings } from '../settings'
import { createMockExportRenderers, type ExportJob, type ExportRenderer } from './renderers'
import { describeExportError, ExportRunError, runExport } from './run'
import { titlePageData } from './title-page'
import { WIZARD_FIXTURE_DOC } from './fixtures'

const ir = buildManuscript(WIZARD_FIXTURE_DOC, FEATURE_FIXTURE_STYLES, { footnotes: FEATURE_FIXTURE_FOOTNOTES })
const settings = defaultManuscriptSettings('en-US')
const job: ExportJob = { ir, settings, titlePage: titlePageData(settings, { legalName: 'Ann Waight', penName: '', address: '', phone: '', email: 'a@b.c', agent: '' }, 'The Long Night', 100) }
const ex = core.exports

async function targets(): Promise<{ docx: SaveTarget; pdf: SaveTarget }> {
  return { docx: (await pickSavePath('docx', 'Waight_THE_LONG_NIGHT_manuscript'))!, pdf: (await pickSavePath('pdf', 'Waight_THE_LONG_NIGHT_manuscript'))! }
}

beforeEach(() => backend.reset())

describe('runExport', () => {
  it('renders every format, then writes each to its Save-dialog target, with progress to 1', async () => {
    const t = await targets()
    const progress: number[] = []
    const written = await runExport(job, ['docx', 'pdf'], t, createMockExportRenderers(), { onProgress: (p) => progress.push(p.fraction) })
    expect(written.map((w) => w.path)).toEqual(['/exports/Waight_THE_LONG_NIGHT_manuscript.docx', '/exports/Waight_THE_LONG_NIGHT_manuscript.pdf'])
    expect(new TextDecoder().decode(ex.written.get(written[0].path))).toContain('The Arrival')
    expect(progress[progress.length - 1]).toBe(1)
    expect(progress).toEqual([...progress].sort((a, b) => a - b))
  })

  it('cancel during a render writes nothing (no file, not even the format already rendered)', async () => {
    const t = await targets()
    const ctl = new AbortController()
    const run = runExport(job, ['docx', 'pdf'], t, createMockExportRenderers({ delayMs: 5 }), {
      signal: ctl.signal,
      onProgress: (p) => {
        if (p.format === 'pdf' && p.fraction > 0.6) ctl.abort()
      },
    })
    await expect(run).rejects.toMatchObject({ problem: 'cancelled' })
    expect(ex.written.size).toBe(0)
  })

  it('a renderer failure writes nothing and says which file could not be made', async () => {
    const t = await targets()
    const failing: ExportRenderer = { format: 'pdf', render: async () => Promise.reject(new Error('bad font table')) }
    const run = runExport(job, ['docx', 'pdf'], t, { ...createMockExportRenderers(), pdf: failing })
    await expect(run).rejects.toMatchObject({ problem: 'render', format: 'pdf', message: 'The PDF could not be made: bad font table' })
    expect(ex.written.size).toBe(0)
  })

  it('a full disk while saving: an error with "choose another location"; the atomic write left nothing', async () => {
    const t = await targets()
    ex.failWrite = { kind: 'disk_full', message: 'No space left on device', diagnostics: [] }
    const err = await runExport(job, ['docx'], t, createMockExportRenderers()).catch((e: ExportRunError) => e)
    expect(err).toBeInstanceOf(ExportRunError)
    expect(err).toMatchObject({ problem: 'disk-full', changeLocation: true, kind: 'disk_full' })
    expect(ex.written.size).toBe(0)
  })

  it('a target the Save dialog did not grant is refused', async () => {
    const err = await runExport(job, ['docx'], { docx: { token: 'forged', path: '/etc/x.docx', kind: 'docx' } }, createMockExportRenderers()).catch((e) => e)
    expect(err).toMatchObject({ problem: 'not-granted', changeLocation: true })
    expect(ex.written.size).toBe(0)
  })

  it('a missing renderer or target is an error before anything runs', async () => {
    await expect(runExport(job, ['pdf'], {}, {})).rejects.toMatchObject({ problem: 'render', message: 'This build of Novel cannot make a PDF yet.' })
    await expect(runExport(job, ['pdf'], {}, createMockExportRenderers())).rejects.toMatchObject({ problem: 'not-granted' })
  })

  it('the fake core refuses to open a file it did not export', async () => {
    expect(await invokeMock('export_open_file', { path: '/nowhere.pdf' }).catch((e: { kind: string }) => e.kind)).toBe('not_exported')
  })
})

describe('describeExportError', () => {
  type Kind = ConstructorParameters<typeof ExportPlatformError>[0]
  const e = (kind: Kind, message = 'x', diagnostics: ConstructorParameters<typeof ExportPlatformError>[2] = []) => new ExportPlatformError(kind, message, diagnostics)
  it.each([
    ['permission_denied', 'permission'],
    ['read_only', 'permission'],
    ['symlink', 'permission'],
    ['disk_full', 'disk-full'],
    ['not_found', 'missing-folder'],
    ['invalid_path', 'missing-folder'],
    ['invalid_token', 'not-granted'],
    ['compile', 'typst'],
    ['timeout', 'typst'],
    ['sidecar_missing', 'typst'],
    ['io', 'other'],
    ['cancelled', 'cancelled'],
  ] as const)('%s -> %s', (kind, problem) => {
    expect(describeExportError(e(kind), 'pdf', 'render').problem).toBe(problem)
  })
  it('a Typst kind while saving (or for the Word file) is not called a Typst failure', () => {
    expect(describeExportError(e('invalid_request'), 'pdf', 'save').problem).toBe('other')
    expect(describeExportError(e('compile'), 'docx', 'render').problem).toBe('other')
  })
  it('a Typst failure names the first error diagnostic', () => {
    const d = describeExportError(e('compile', 'compile failed', [{ severity: 'error', file: 'template', line: 3, column: 1, message: 'unknown variable: x', hints: [] }]), 'pdf', 'render')
    expect(d.message).toMatch(/Typst: unknown variable: x/)
    expect(d.diagnostics).toHaveLength(1)
    expect(d.changeLocation).toBe(false)
  })
  it('an AbortError is a cancel', () => {
    expect(describeExportError(new DOMException('x', 'AbortError'), 'docx', 'render').problem).toBe('cancelled')
  })
})
