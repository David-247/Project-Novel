import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { defaultBookSettings } from '@/shared/book'
import { createMemoryDocumentProvider, registerDocumentProvider, type DocJSON } from '@/shared/document'
import { useStore } from '@/shared/store'
import { initialProjectState } from '@/shared/store/project-slice'
import { backend } from '@/test-utils/fake-tauri'

vi.mock('@tauri-apps/api/core', async () => (await import('@/test-utils/fake-tauri')).coreModule)
vi.mock('@tauri-apps/plugin-dialog', async () => (await import('@/test-utils/fake-tauri')).dialogModule)
vi.mock('@tauri-apps/plugin-sql', async () => (await import('@/test-utils/fake-tauri')).sqlModule)

import {
  AUTOSAVE_INTERVAL_MS,
  closeProject,
  confirmUnsavedChanges,
  loadRecentProjects,
  newProject,
  openProject,
  restoreRecovery,
  SaveStatusIndicator,
  saveProject,
  startAutosave,
} from './index'
import { __resetAutosaveForTests } from './autosave'
import { prepareToExit } from './integration'
import { __resetStorageForTests } from './project'
import { parseBook, serializeBook } from './book-file'
import { serializeManuscript, type ProjectMeta } from './format'
import { judgeRecovery, parseRecovery, serializeRecovery } from './recovery'
import { __resetWriteLockForTests } from './write-lock'

const ROOT = '/books/novel'
const BOOK = `${ROOT}/book.json`
const MANUSCRIPT = `${ROOT}/manuscript.json`
const RECOVERY = `${ROOT}/.recovery/manuscript.json`

const textDoc = (text: string): DocJSON => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
})
const book = () => useStore.getState().book
const bookActions = () => useStore.getState().bookActions
const onDisk = () => JSON.parse(backend.files.get(BOOK)!)

let editor = createMemoryDocumentProvider()
let unregister = () => {}

/** Simulate an app launch: fresh in-memory state, same disk + recent file. */
async function launch() {
  await __resetAutosaveForTests()
  await __resetStorageForTests()
  __resetWriteLockForTests()
  useStore.setState({ project: initialProjectState })
  bookActions().resetBook()
  unregister()
  editor = createMemoryDocumentProvider()
  unregister = registerDocumentProvider(editor)
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

beforeEach(async () => {
  vi.useFakeTimers()
  backend.reset()
  await launch()
})

afterEach(async () => {
  cleanup()
  await __resetAutosaveForTests()
  unregister()
  vi.useRealTimers()
})

describe('book.json persistence', () => {
  it('a new project gets a default book.json', async () => {
    await createProject()
    expect(onDisk()).toMatchObject({ format: 'novel-book', version: 1, trimSize: 'us-5.5x8.5', surface: 'auto', view: 'spread' })
    expect(book().dirty).toBe(false)
  })

  it('a trim size change marks the project unsaved, survives save, close and reopen', async () => {
    await createProject()
    bookActions().setTrimSize('uk-a5')
    expect(book().dirty).toBe(true)
    expect(await saveProject()).toBe(true)
    expect(book().dirty).toBe(false)
    expect(onDisk().trimSize).toBe('uk-a5')

    await closeProject()
    expect(book().trimSize).toBe('us-5.5x8.5') // closed project: back to defaults
    await launch()
    await reopen()
    expect(book()).toMatchObject({ trimSize: 'uk-a5', dirty: false })
  })

  it('a book-only change shows as unsaved and a save with no text change still writes it', async () => {
    await createProject()
    render(<SaveStatusIndicator />)
    expect(screen.getByRole('status').textContent).toMatch(/novel: All changes saved/)
    act(() => bookActions().setSurface('dark'))
    expect(editor.isDirty()).toBe(false)
    expect(screen.getByRole('status').textContent).toMatch(/Unsaved changes/)
    await act(async () => {
      expect(await saveProject()).toBe(true)
    })
    expect(onDisk().surface).toBe('dark')
    expect(screen.getByRole('status').textContent).toMatch(/novel: Saved/)
  })

  it('a change made while the save is in flight keeps the settings unsaved', async () => {
    await createProject()
    bookActions().setView('single')
    let release = () => {}
    backend.writeGate = (path: string) => (path === BOOK ? new Promise<void>((r) => (release = r)) : Promise.resolve())
    const saving = saveProject()
    await vi.advanceTimersByTimeAsync(0)
    bookActions().setSurface('white')
    release()
    expect(await saving).toBe(true)
    backend.writeGate = null
    expect(onDisk()).toMatchObject({ view: 'single', surface: 'auto' })
    expect(book().dirty).toBe(true)
  })

  it('a Phase 1 project without book.json opens with defaults and no warning', async () => {
    await createProject()
    backend.files.delete(BOOK)
    await launch()
    await reopen()
    expect(book()).toMatchObject({ ...defaultBookSettings(), dirty: false })
    expect(useStore.getState().project.bookWarning).toBeNull()
    expect(backend.messages).toEqual([])
  })

  it('a corrupt book.json opens with defaults plus a warning, and manuscript.json is untouched', async () => {
    await createProject()
    editor.update(textDoc('my chapter'))
    await saveProject()
    const manuscript = backend.files.get(MANUSCRIPT)
    backend.files.set(BOOK, '{"trimSize": "uk-a5", ')
    backend.writes.length = 0
    await launch()
    await reopen()
    expect(book()).toMatchObject({ ...defaultBookSettings(), dirty: false })
    expect(useStore.getState().project.bookWarning).toMatch(/book\.json is damaged.*not changed/)
    expect(backend.messages).toEqual([]) // non-blocking
    expect(backend.files.get(MANUSCRIPT)).toBe(manuscript)
    expect(backend.writes).not.toContain(MANUSCRIPT)
    expect(editor.getDocJSON()).toEqual(textDoc('my chapter'))
  })

  it('invalid values load as defaults with a warning; unknown keys survive a save', async () => {
    await createProject()
    backend.files.set(BOOK, JSON.stringify({ trimSize: 'uk-demy', surface: 'neon', styles: { a: { b: 1 } }, newer: [1] }))
    await launch()
    await reopen()
    expect(book()).toMatchObject({ trimSize: 'uk-demy', surface: 'auto', styles: { a: { b: 1 } } })
    expect(useStore.getState().project.bookWarning).toMatch(/invalid values \(the paper surface\)/)
    bookActions().setView('single')
    await saveProject()
    expect(onDisk()).toMatchObject({ trimSize: 'uk-demy', newer: [1], styles: { a: { b: 1 } }, view: 'single' })
  })
})

describe('an unreadable or damaged book.json is not silently overwritten', () => {
  const asides = () => [...backend.files.keys()].filter((k) => k.startsWith(`${ROOT}/book.damaged-`))

  it('a read failure followed by a text-only save leaves book.json byte-identical', async () => {
    await createProject()
    bookActions().setTrimSize('uk-a5')
    await saveProject()
    const real = backend.files.get(BOOK)
    await launch()
    backend.failRead = (p) => (p === BOOK ? { kind: 'permission_denied', message: 'locked' } : null)
    await reopen()
    backend.failRead = null
    expect(useStore.getState().project.bookWarning).toMatch(/could not be read.*left as it is/)
    editor.update(textDoc('typed'))
    expect(await saveProject()).toBe(true)
    expect(backend.files.get(BOOK)).toBe(real)
    expect(asides()).toEqual([])
    expect(useStore.getState().project.bookWarning).not.toBeNull()
  })

  it('a damaged file followed by a book change keeps a copy aside, then writes the new settings', async () => {
    await createProject()
    backend.files.set(BOOK, '{"trimSize": "uk-a5", ')
    await launch()
    await reopen()
    editor.update(textDoc('typed'))
    await saveProject()
    expect(backend.files.get(BOOK)).toBe('{"trimSize": "uk-a5", ')
    expect(asides()).toEqual([])
    // View and paper are display toggles: they never replace a guarded book.json.
    bookActions().setSurface('dark')
    bookActions().setView('single')
    await saveProject()
    expect(backend.files.get(BOOK)).toBe('{"trimSize": "uk-a5", ')
    expect(asides()).toEqual([])
    expect(book().dirty).toBe(false)
    bookActions().setTrimSize('us-6x9')
    await saveProject()
    expect(asides()).toHaveLength(1)
    expect(backend.files.get(asides()[0])).toBe('{"trimSize": "uk-a5", ')
    expect(onDisk()).toMatchObject({ trimSize: 'us-6x9', surface: 'dark', view: 'single' })
    expect(useStore.getState().project.bookWarning).toBeNull()
  })

  it('a file with only some invalid fields is rewritten by a normal save (no aside copy)', async () => {
    await createProject()
    backend.files.set(BOOK, JSON.stringify({ trimSize: 'nope' }))
    await launch()
    await reopen()
    editor.update(textDoc('typed'))
    await saveProject()
    expect(onDisk().trimSize).toBe('us-5.5x8.5')
    expect(asides()).toEqual([])
  })

  it('a book.json from a newer Novel loads with a warning, is left alone until a book change, then is copied aside', async () => {
    await createProject()
    const newer = JSON.stringify({ format: 'novel-book', version: 2, trimSize: 'uk-a5', surface: 'dark', margins: { top: 50, gutterMirror: true } })
    backend.files.set(BOOK, newer)
    await launch()
    await reopen()
    expect(book()).toMatchObject({ trimSize: 'uk-a5', surface: 'dark' })
    expect(useStore.getState().project.bookWarning).toMatch(/newer version of Novel.*left as it is/)
    const newerAsides = () => [...backend.files.keys()].filter((k) => k.startsWith(`${ROOT}/book.newer-`))
    // A text-only save (and an autosave snapshot) never rewrites it.
    editor.update(textDoc('typed'))
    await vi.advanceTimersByTimeAsync(AUTOSAVE_INTERVAL_MS)
    expect(await saveProject()).toBe(true)
    expect(backend.files.get(BOOK)).toBe(newer)
    expect(newerAsides()).toEqual([])
    // Switching view or paper does not replace it.
    bookActions().setView('single')
    bookActions().setSurface('book')
    expect(await saveProject()).toBe(true)
    expect(backend.files.get(BOOK)).toBe(newer)
    expect(newerAsides()).toEqual([])
    // A real book change: the original is kept aside first, then the file is written by this version.
    bookActions().setStyles((st) => ({ ...st, body: { fontSize: 12 } }))
    expect(await saveProject()).toBe(true)
    expect(newerAsides()).toHaveLength(1)
    expect(backend.files.get(newerAsides()[0])).toBe(newer)
    expect(onDisk()).toMatchObject({ version: 1, trimSize: 'uk-a5', surface: 'book', view: 'single', styles: { body: { fontSize: 12 } } })
    expect(asides()).toEqual([])
    expect(useStore.getState().project.bookWarning).toBeNull()
  })

  it('REGRESSION: a text-only crash restore never replaces a newer book.json', async () => {
    await createProject()
    const newer = JSON.stringify({ format: 'novel-book', version: 2, trimSize: 'uk-a5' })
    backend.files.set(BOOK, newer)
    await launch()
    await reopen()
    editor.update(textDoc('typed after opening'))
    await vi.advanceTimersByTimeAsync(AUTOSAVE_INTERVAL_MS)
    await launch() // crash
    await reopen()
    expect(await restoreRecovery()).toBe(true)
    expect(editor.getDocJSON()).toEqual(textDoc('typed after opening'))
    expect(book().dirty).toBe(false)
    expect(await saveProject()).toBe(true)
    expect(backend.files.get(BOOK)).toBe(newer)
    expect([...backend.files.keys()].filter((k) => k.startsWith(`${ROOT}/book.newer-`))).toEqual([])
  })

  it('REGRESSION: if the copy cannot be kept, book.json is not replaced; the settings stay unsaved with a warning', async () => {
    await createProject()
    backend.files.set(BOOK, 'garbage')
    await launch()
    await reopen()
    bookActions().setTrimSize('us-6x9')
    backend.failWrite = (p: string) => (p.includes('/book.damaged-') ? { kind: 'disk_full', message: 'full' } : null)
    expect(await saveProject()).toBe(true) // the manuscript is saved
    expect(backend.files.get(BOOK)).toBe('garbage')
    expect(asides()).toEqual([])
    expect(book().dirty).toBe(true)
    expect(useStore.getState().project.bookWarning).toMatch(/could not keep a copy.*left as it is/)
    // The next save retries and, with the copy kept, writes the settings.
    backend.failWrite = null
    expect(await saveProject()).toBe(true)
    expect(asides()).toHaveLength(1)
    expect(onDisk()).toMatchObject({ trimSize: 'us-6x9' })
    expect(book().dirty).toBe(false)
    expect(useStore.getState().project.bookWarning).toBeNull()
  })

  it('REGRESSION: after a save whose book copy failed, a crash still offers the unsaved book settings', async () => {
    await createProject()
    backend.files.set(BOOK, 'garbage')
    await launch()
    await reopen()
    bookActions().setTrimSize('us-6x9')
    await vi.advanceTimersByTimeAsync(AUTOSAVE_INTERVAL_MS) // snapshot on top of the opened save
    backend.failWrite = (p: string) => (p.includes('/book.damaged-') ? { kind: 'disk_full', message: 'full' } : null)
    expect(await saveProject()).toBe(true) // manuscript saved, updatedAt moved, book still unsaved
    backend.failWrite = null
    expect(book().dirty).toBe(true)
    await vi.advanceTimersByTimeAsync(AUTOSAVE_INTERVAL_MS) // no further edits: the snapshot is retaken anyway
    await launch() // crash
    await reopen()
    expect(useStore.getState().project.recoveryPrompt).toMatchObject({ kind: 'restore' })
    expect(await restoreRecovery()).toBe(true)
    expect(book().trimSize).toBe('us-6x9')
    expect(backend.files.get(BOOK)).toBe('garbage')
  })

  it('REGRESSION: a crash 1 s after a save whose book copy failed still offers the unsaved book settings', async () => {
    await createProject()
    backend.files.set(BOOK, 'garbage')
    await launch()
    await reopen()
    bookActions().setTrimSize('us-6x9')
    await vi.advanceTimersByTimeAsync(AUTOSAVE_INTERVAL_MS)
    backend.failWrite = (p: string) => (p.includes('/book.damaged-') ? { kind: 'disk_full', message: 'full' } : null)
    expect(await saveProject()).toBe(true)
    backend.failWrite = null
    await vi.advanceTimersByTimeAsync(1000)
    await launch() // crash
    await reopen()
    expect(useStore.getState().project.recoveryPrompt).toMatchObject({ kind: 'restore' })
    expect(await restoreRecovery()).toBe(true)
    expect(book().trimSize).toBe('us-6x9')
  })

  it('the warning survives a later set-aside note and clears when the project closes', async () => {
    await createProject()
    backend.files.set(BOOK, 'garbage')
    await launch()
    await reopen()
    useStore.getState().projectActions.setRecoveryNotice('some other note')
    expect(useStore.getState().project.bookWarning).not.toBeNull()
    await closeProject()
    expect(useStore.getState().project.bookWarning).toBeNull()
  })
})

describe('unknown keys through crash recovery', () => {
  it('an unknown top-level key survives snapshot, restore and save, still top-level', async () => {
    await createProject()
    backend.files.set(BOOK, JSON.stringify({ ...onDisk(), newer: { keep: 1 } }))
    await launch()
    await reopen()
    bookActions().setSurface('dark')
    await vi.advanceTimersByTimeAsync(AUTOSAVE_INTERVAL_MS)
    expect(JSON.parse(backend.files.get(RECOVERY)!).book).toMatchObject({ newer: { keep: 1 }, surface: 'dark' })
    expect(JSON.parse(backend.files.get(RECOVERY)!).book.extra).toBeUndefined()
    await launch()
    await reopen()
    expect(await restoreRecovery()).toBe(true)
    expect(await saveProject()).toBe(true)
    expect(onDisk()).toMatchObject({ newer: { keep: 1 }, surface: 'dark' })
    expect(onDisk().extra).toBeUndefined()
  })

  it('an identical snapshot with an unknown key is judged identical', () => {
    const settings = { ...defaultBookSettings(), extra: { newer: 1 } }
    const snap = parseRecovery(
      serializeRecovery({
        format: 'novel-recovery',
        version: 2,
        projectId: 'p',
        savedAt: new Date().toISOString(),
        baseUpdatedAt: 'b',
        docVersion: 1,
        doc: textDoc('x'),
        book: settings,
      }),
    )!
    const meta = { id: 'p', updatedAt: 'b' } as ProjectMeta
    expect(judgeRecovery(snap, meta, serializeManuscript(textDoc('x')), parseBook(serializeBook(settings)).settings)).toBe('identical')
  })
})

describe('unsaved-changes prompts and exit', () => {
  it('the close/quit prompts treat unsaved book settings like unsaved text', async () => {
    await createProject()
    expect(await confirmUnsavedChanges()).toBe(true)
    expect(backend.messages).toHaveLength(0)
    bookActions().setTrimSize('us-6x9')
    backend.answer = 'Cancel'
    expect(await prepareToExit('closing')).toBe(false)
    expect(backend.messages).toHaveLength(1)
    backend.answer = 'Save'
    expect(await prepareToExit('quitting')).toBe(true)
    expect(onDisk().trimSize).toBe('us-6x9')
  })

  it("Don't Save drops the book change and stops it being snapshotted again", async () => {
    await createProject()
    bookActions().setTrimSize('us-6x9')
    backend.answer = "Don't Save"
    expect(await confirmUnsavedChanges()).toBe(true)
    await vi.advanceTimersByTimeAsync(AUTOSAVE_INTERVAL_MS)
    expect(backend.files.has(RECOVERY)).toBe(false)
  })
})

describe('crash recovery of book settings', () => {
  it('a book-only change is snapshotted within 30 s, with the text', async () => {
    await createProject()
    expect(backend.files.has(RECOVERY)).toBe(false)
    bookActions().setTrimSize('uk-royal')
    await vi.advanceTimersByTimeAsync(AUTOSAVE_INTERVAL_MS - 1)
    expect(backend.files.has(RECOVERY)).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    const snap = parseRecovery(backend.files.get(RECOVERY)!)!
    expect(snap.version).toBe(2)
    expect(snap.book?.trimSize).toBe('uk-royal')
    expect(onDisk().trimSize).toBe('us-5.5x8.5') // never over book.json
  })

  it('Restore brings back unsaved book settings together with the text', async () => {
    await createProject()
    editor.update(textDoc('unsaved prose'))
    bookActions().setTrimSize('uk-b-format')
    bookActions().setSurface('dark')
    await vi.advanceTimersByTimeAsync(AUTOSAVE_INTERVAL_MS)
    await launch() // crash
    await reopen()
    expect(book().trimSize).toBe('us-5.5x8.5') // as saved
    expect(await restoreRecovery()).toBe(true)
    expect(editor.getDocJSON()).toEqual(textDoc('unsaved prose'))
    expect(book()).toMatchObject({ trimSize: 'uk-b-format', surface: 'dark', dirty: true })
    expect(await saveProject()).toBe(true)
    expect(onDisk()).toMatchObject({ trimSize: 'uk-b-format', surface: 'dark' })
    expect(backend.files.has(RECOVERY)).toBe(false)
  })

  it('a snapshot whose text equals the manuscript but whose book differs is still offered', async () => {
    await createProject()
    bookActions().setTrimSize('uk-demy')
    await vi.advanceTimersByTimeAsync(AUTOSAVE_INTERVAL_MS)
    await launch()
    await reopen()
    expect(useStore.getState().project.recoveryPrompt).toMatchObject({ kind: 'restore' })
    await restoreRecovery()
    expect(book().trimSize).toBe('uk-demy')
  })

  it('a version 1 snapshot (no book field) still restores the text and leaves the book alone', async () => {
    await createProject()
    const meta = JSON.parse(backend.files.get(`${ROOT}/project.json`)!) as { id: string; updatedAt: string }
    backend.dirs.add(`${ROOT}/.recovery`)
    backend.files.set(
      RECOVERY,
      JSON.stringify({
        format: 'novel-recovery',
        version: 1,
        projectId: meta.id,
        savedAt: new Date().toISOString(),
        baseUpdatedAt: meta.updatedAt,
        docVersion: 1,
        doc: textDoc('old format'),
      }),
    )
    await launch()
    await reopen()
    expect(await restoreRecovery()).toBe(true)
    expect(editor.getDocJSON()).toEqual(textDoc('old format'))
    expect(book()).toMatchObject({ ...defaultBookSettings(), dirty: false })
  })
})
