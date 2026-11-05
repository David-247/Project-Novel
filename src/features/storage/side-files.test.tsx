import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryDocumentProvider, registerDocumentProvider, type DocJSON } from '@/shared/document'
import { useStore } from '@/shared/store'
import { initialProjectState } from '@/shared/store/project-slice'
import { backend } from '@/test-utils/fake-tauri'

vi.mock('@tauri-apps/api/core', async () => (await import('@/test-utils/fake-tauri')).coreModule)
vi.mock('@tauri-apps/plugin-dialog', async () => (await import('@/test-utils/fake-tauri')).dialogModule)
vi.mock('@tauri-apps/plugin-sql', async () => (await import('@/test-utils/fake-tauri')).sqlModule)

import { AUTOSAVE_INTERVAL_MS, loadRecentProjects, newProject, openProject, registerSideFile, restoreRecovery, saveProject, startAutosave } from './index'
import { __resetAutosaveForTests } from './autosave'
import { prepareToExit } from './integration'
import { __resetStorageForTests } from './project'
import { parseRecovery } from './recovery'
import { __resetSideFilesForTests, type ProjectSideFile } from './side-files'
import { __resetWriteLockForTests } from './write-lock'

const ROOT = '/books/novel'
const NOTES = `${ROOT}/notes.json`
const MANUSCRIPT = `${ROOT}/manuscript.json`
const RECOVERY = `${ROOT}/.recovery/manuscript.json`

const textDoc = (text: string): DocJSON => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] })

/** A slice's side file: `{ version, items }`, unknown keys kept; version 2+ is "newer". */
function fakeSideFile() {
  let data: Record<string, unknown> | null = null
  let version = 0
  const loads: unknown[] = []
  const file: ProjectSideFile & { change(items: string[]): void; items(): unknown; loads: unknown[]; closing: unknown } = {
    name: 'notes.json',
    loads,
    closing: null,
    load(d) {
      loads.push(d)
      data = d ? structuredClone(d as Record<string, unknown>) : null
      const v = (d as { version?: number } | null)?.version
      return typeof v === 'number' && v > 1 ? { newer: v } : undefined
    },
    serialize() {
      const items = (data?.items as unknown[] | undefined) ?? []
      return { data: { version: 1, ...(data ?? {}), items }, empty: items.length === 0 }
    },
    getVersion: () => version,
    change(items) {
      data = { ...(data ?? {}), version: 1, items }
      version++
      // In the app a thread change is a document step: the manuscript becomes unsaved too.
      editor.update(editor.getDocJSON())
    },
    items: () => data?.items,
    closeData: () => file.closing,
  }
  return file
}

let editor = createMemoryDocumentProvider()
let unregister = () => {}
let side = fakeSideFile()
let unregisterSide = () => {}

async function launch() {
  await __resetAutosaveForTests()
  await __resetStorageForTests()
  __resetWriteLockForTests()
  __resetSideFilesForTests()
  useStore.setState({ project: initialProjectState })
  unregister()
  editor = createMemoryDocumentProvider()
  unregister = registerDocumentProvider(editor)
  side = fakeSideFile()
  unregisterSide = registerSideFile(side)
  backend.active = backend.previous = null
  backend.messages.length = 0
  startAutosave()
}

async function createProject() {
  backend.dirs.add(ROOT)
  backend.pick = ROOT
  expect(await newProject()).toBe(true)
}

async function reopen() {
  await loadRecentProjects()
  expect(await openProject(ROOT)).toBe(true)
}

const onDisk = () => JSON.parse(backend.files.get(NOTES)!)
const warning = () => useStore.getState().project.sideFileWarning

beforeEach(async () => {
  vi.useFakeTimers()
  backend.reset()
  await launch()
})

afterEach(async () => {
  await __resetAutosaveForTests()
  unregister()
  unregisterSide()
  vi.useRealTimers()
})

describe('project side files', () => {
  it('a project without the file opens with it empty, and an empty one is never created', async () => {
    await createProject()
    expect(side.loads.at(-1)).toBeNull()
    editor.update(textDoc('text'))
    expect(await saveProject()).toBe(true)
    expect(backend.files.has(NOTES)).toBe(false)
    await launch()
    await reopen()
    expect(side.loads).toEqual([null])
    expect(warning()).toBeNull()
  })

  it('is written in one batch with the manuscript (side file first), and read back on reopen', async () => {
    await createProject()
    side.change(['a'])
    editor.update(textDoc('anchor'))
    backend.writes.length = 0
    expect(await saveProject()).toBe(true)
    expect(backend.writes.slice(0, 2)).toEqual([NOTES, MANUSCRIPT])
    expect(onDisk()).toEqual({ version: 1, items: ['a'] })
    await launch()
    await reopen()
    expect(side.items()).toEqual(['a'])
  })

  it('keeps unknown keys the slice hands back', async () => {
    await createProject()
    backend.files.set(NOTES, JSON.stringify({ version: 1, items: ['x'], later: { keep: true } }))
    await launch()
    await reopen()
    side.change(['x', 'y'])
    expect(await saveProject()).toBe(true)
    expect(onDisk()).toEqual({ version: 1, items: ['x', 'y'], later: { keep: true } })
  })

  it('a failure staging the side file writes nothing (the manuscript stays as saved)', async () => {
    await createProject()
    const before = backend.files.get(MANUSCRIPT)
    side.change(['a'])
    editor.update(textDoc('new text'))
    backend.failWrite = (p) => (p === NOTES ? { kind: 'disk_full', message: 'full' } : null)
    expect(await saveProject({ silent: true })).toBe(false)
    expect(backend.files.get(MANUSCRIPT)).toBe(before)
    expect(backend.files.has(NOTES)).toBe(false)
    expect(editor.isDirty()).toBe(true)
    backend.failWrite = null
    expect(await saveProject()).toBe(true)
    expect(onDisk().items).toEqual(['a'])
  })

  it('a damaged file loads empty, is not overwritten until a real change, then is copied aside first', async () => {
    await createProject()
    backend.files.set(NOTES, '{ not json')
    await launch()
    await reopen()
    expect(side.loads).toEqual([null])
    expect(warning()).toMatch(/notes\.json is damaged/)
    editor.update(textDoc('text only'))
    expect(await saveProject()).toBe(true)
    expect(backend.files.get(NOTES)).toBe('{ not json')
    expect(warning()).toMatch(/damaged/)

    side.change(['fresh'])
    expect(await saveProject()).toBe(true)
    expect(onDisk().items).toEqual(['fresh'])
    const copies = [...backend.files.keys()].filter((k) => k.startsWith(`${ROOT}/notes.damaged-`))
    expect(copies).toHaveLength(1)
    expect(backend.files.get(copies[0])).toBe('{ not json')
    expect(warning()).toBeNull()
  })

  it('a newer file is used, guarded, and copied aside as notes.newer-*.json before the first overwrite', async () => {
    await createProject()
    const newer = JSON.stringify({ version: 2, items: ['n'], future: 1 })
    backend.files.set(NOTES, newer)
    await launch()
    await reopen()
    expect(side.items()).toEqual(['n'])
    expect(warning()).toMatch(/newer version of Novel \(format version 2\)/)
    editor.update(textDoc('t'))
    expect(await saveProject()).toBe(true)
    expect(backend.files.get(NOTES)).toBe(newer)
    side.change(['n', 'm'])
    expect(await saveProject()).toBe(true)
    expect(onDisk()).toMatchObject({ items: ['n', 'm'], future: 1 })
    const copies = [...backend.files.keys()].filter((k) => k.startsWith(`${ROOT}/notes.newer-`))
    expect(copies.map((k) => backend.files.get(k))).toEqual([newer])
  })

  it('when the copy of a guarded file cannot be kept, only that file is skipped: the manuscript is saved, the change stays unsaved', async () => {
    await createProject()
    backend.files.set(NOTES, 'damaged')
    await launch()
    await reopen()
    side.change(['x'])
    editor.update(textDoc('text to keep'))
    backend.failWrite = (p) => (p.includes('notes.damaged-') ? { kind: 'permission_denied', message: 'denied' } : null)
    expect(await saveProject({ silent: true })).toBe(true)
    expect(JSON.parse(backend.files.get(MANUSCRIPT)!)).toEqual(textDoc('text to keep'))
    expect(backend.files.get(NOTES)).toBe('damaged')
    expect(warning()).toMatch(/Your changes to notes.json were not saved/)
    expect(editor.isDirty()).toBe(true)
    // The copy works again: the next save copies the original aside and writes the file.
    backend.failWrite = null
    expect(await saveProject()).toBe(true)
    expect(onDisk().items).toEqual(['x'])
    expect(editor.isDirty()).toBe(false)
    expect(warning()).toBeNull()
  })

  it('a side file that stays unreadable never blocks saving the manuscript', async () => {
    await createProject()
    backend.files.set(NOTES, JSON.stringify({ version: 1, items: ['on disk'] }))
    backend.failRead = (p) => (p === NOTES ? { kind: 'permission_denied', message: 'locked' } : null)
    await launch()
    backend.failRead = (p) => (p === NOTES ? { kind: 'permission_denied', message: 'locked' } : null)
    await reopen()
    expect(warning()).toMatch(/notes.json is damaged or could not be read/)
    side.change(['new'])
    for (const text of ['first save', 'second save']) {
      editor.update(textDoc(text))
      expect(await saveProject({ silent: true })).toBe(true)
      expect(JSON.parse(backend.files.get(MANUSCRIPT)!)).toEqual(textDoc(text))
      expect(warning()).toMatch(/were not saved/)
      expect(editor.isDirty()).toBe(true)
    }
    expect(JSON.parse(backend.files.get(NOTES)!).items).toEqual(['on disk'])
    backend.failRead = null
  })

  it('autosave snapshots the side file; a side-only change is offered (not judged identical) and restored', async () => {
    await createProject()
    side.change(['unsaved'])
    await vi.advanceTimersByTimeAsync(AUTOSAVE_INTERVAL_MS)
    const snap = parseRecovery(backend.files.get(RECOVERY)!)!
    expect(snap.sideFiles).toEqual({ 'notes.json': { version: 1, items: ['unsaved'] } })
    await launch() // crash
    await reopen()
    expect(useStore.getState().project.recoveryPrompt).toMatchObject({ kind: 'restore' })
    expect(side.items()).toBeUndefined()
    expect(await restoreRecovery()).toBe(true)
    expect(side.items()).toEqual(['unsaved'])
    expect(await saveProject()).toBe(true)
    expect(onDisk().items).toEqual(['unsaved'])
  })

  it('a snapshot from before side files restores only the text', async () => {
    await createProject()
    side.change(['saved'])
    expect(await saveProject()).toBe(true)
    const meta = JSON.parse(backend.files.get(`${ROOT}/project.json`)!) as { id: string; updatedAt: string }
    backend.dirs.add(`${ROOT}/.recovery`)
    backend.files.set(
      RECOVERY,
      JSON.stringify({ format: 'novel-recovery', version: 2, projectId: meta.id, savedAt: new Date().toISOString(), baseUpdatedAt: meta.updatedAt, docVersion: 1, doc: textDoc('older') }),
    )
    await launch()
    await reopen()
    expect(await restoreRecovery()).toBe(true)
    expect(editor.getDocJSON()).toEqual(textDoc('older'))
    expect(side.items()).toEqual(['saved'])
  })

  it('closing a saved project writes the close data (orphans pruned on close, not on save)', async () => {
    await createProject()
    side.change(['keep', 'orphan'])
    expect(await saveProject()).toBe(true)
    side.closing = { version: 1, items: ['keep'] }
    expect(await prepareToExit('quitting')).toBe(true)
    expect(onDisk().items).toEqual(['keep'])
  })

  it("closing with Don't Save leaves the file as saved", async () => {
    await createProject()
    side.change(['a', 'b'])
    expect(await saveProject()).toBe(true)
    side.change(['a'])
    side.closing = { version: 1, items: [] }
    backend.answer = "Don't Save"
    expect(await prepareToExit('quitting')).toBe(true)
    expect(onDisk().items).toEqual(['a', 'b'])
  })

  it('New Project refuses a folder holding a leftover side file', async () => {
    backend.dirs.add(ROOT)
    backend.files.set(NOTES, '{}')
    backend.pick = ROOT
    expect(await newProject()).toBe(false)
    expect(backend.messages.at(-1)?.text).toMatch(/notes\.json from an earlier project/)
  })
})
