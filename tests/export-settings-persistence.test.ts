import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryDocumentProvider, registerDocumentProvider, type DocJSON } from '@/shared/document'
import { useStore } from '@/shared/store'
import { initialProjectState } from '@/shared/store/project-slice'
import { backend } from '@/test-utils/fake-tauri'

vi.mock('@tauri-apps/api/core', async () => (await import('@/test-utils/fake-tauri')).coreModule)
vi.mock('@tauri-apps/plugin-dialog', async () => (await import('@/test-utils/fake-tauri')).dialogModule)
vi.mock('@tauri-apps/plugin-sql', async () => (await import('@/test-utils/fake-tauri')).sqlModule)

import {
  AUTOSAVE_INTERVAL_MS,
  loadRecentProjects,
  newProject,
  openProject,
  restoreRecovery,
  saveProject,
  saveProjectCopy,
  startAutosave,
} from '@/features/storage'
import {
  defaultManuscriptSettings,
  getContactOverride,
  getManuscriptSettings,
  getResolvedContact,
  registerExportSideFile,
  setContactOverride,
  setLastOutputFolder,
  setPreset,
  updateManuscriptSettings,
} from '@/features/export'
import { __resetExportSettingsForTests } from '@/features/export/settings/store'

// Test-only resets of storage internals: this test drives the real storage slice end to end with the
// export settings registered as a side file (it lives in tests/, outside the slice-import rule).
import { __resetAutosaveForTests } from '@/features/storage/autosave'
import { __resetStorageForTests } from '@/features/storage/project'
import { __resetSideFilesForTests } from '@/features/storage/side-files'
import { __resetWriteLockForTests } from '@/features/storage/write-lock'

const ROOT = '/books/novel'
const FILE = `${ROOT}/export.json`
const MANUSCRIPT = `${ROOT}/manuscript.json`
const RECOVERY = `${ROOT}/.recovery/manuscript.json`

const textDoc = (text: string): DocJSON => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] })

let editor = createMemoryDocumentProvider()
let unregister = () => {}
let unregisterSide = () => {}

async function launch() {
  await __resetAutosaveForTests()
  await __resetStorageForTests()
  __resetWriteLockForTests()
  __resetSideFilesForTests()
  __resetExportSettingsForTests()
  useStore.setState({ project: initialProjectState })
  useStore.getState().bookActions.resetBook()
  unregister()
  editor = createMemoryDocumentProvider()
  unregister = registerDocumentProvider(editor)
  unregisterSide = registerExportSideFile()
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

const onDisk = () => JSON.parse(backend.files.get(FILE)!)

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

describe('export.json', () => {
  it('a project without it opens with the defaults, and saving does not create it', async () => {
    await createProject()
    expect(getManuscriptSettings()).toEqual(defaultManuscriptSettings(navigator.language))
    editor.update(textDoc('text'))
    expect(await saveProject()).toBe(true)
    expect(backend.files.has(FILE)).toBe(false)
    await launch()
    await reopen()
    expect(getManuscriptSettings().preset).toBe('standard')
    expect(useStore.getState().project.sideFileWarning).toBeNull()
  })

  it('round-trips through save and reopen, written in one batch with the manuscript', async () => {
    await createProject()
    setPreset('classic')
    updateManuscriptSettings({ paper: 'a4', sceneBreak: '* * *', lineSpacing: 1.5 })
    expect(editor.isDirty()).toBe(true)
    backend.writes.length = 0
    expect(await saveProject()).toBe(true)
    expect(backend.writes.slice(0, 2)).toEqual([FILE, MANUSCRIPT])
    expect(onDisk()).toMatchObject({ version: 1, settings: { preset: 'classic', paper: 'a4', fontFamily: 'Courier New', italics: 'underline', sceneBreak: '* * *', lineSpacing: 1.5 } })
    const saved = getManuscriptSettings()
    await launch()
    await reopen()
    expect(getManuscriptSettings()).toEqual(saved)
  })

  it('autosave snapshots it; after a crash Restore brings it back', async () => {
    await createProject()
    updateManuscriptSettings({ sceneBreak: '***', endMarker: 'end' })
    await vi.advanceTimersByTimeAsync(AUTOSAVE_INTERVAL_MS)
    const snap = JSON.parse(backend.files.get(RECOVERY)!)
    expect(snap.sideFiles['export.json'].settings).toMatchObject({ sceneBreak: '***', endMarker: 'end' })
    await launch() // crash
    await reopen()
    expect(useStore.getState().project.recoveryPrompt).toMatchObject({ kind: 'restore' })
    expect(getManuscriptSettings().sceneBreak).toBe('#')
    expect(await restoreRecovery()).toBe(true)
    expect(getManuscriptSettings()).toMatchObject({ sceneBreak: '***', endMarker: 'end' })
    expect(await saveProject()).toBe(true)
    expect(onDisk().settings).toMatchObject({ sceneBreak: '***', endMarker: 'end' })
  })

  it('a snapshot over a saved file restores the unsaved change, not the saved one', async () => {
    await createProject()
    updateManuscriptSettings({ sceneBreak: '* * *' })
    expect(await saveProject()).toBe(true)
    updateManuscriptSettings({ sceneBreak: '~' })
    await vi.advanceTimersByTimeAsync(AUTOSAVE_INTERVAL_MS)
    await launch() // crash
    await reopen()
    expect(getManuscriptSettings().sceneBreak).toBe('* * *')
    expect(await restoreRecovery()).toBe(true)
    expect(getManuscriptSettings().sceneBreak).toBe('~')
  })

  it('personal contact details reach the project only through a per-project override', async () => {
    await createProject()
    useStore.getState().preferencesActions.set('profileLegalName', 'Augusta Ada King')
    useStore.getState().preferencesActions.set('profileEmail', 'ada@example.com')
    updateManuscriptSettings({ sceneBreak: '***' })
    expect(await saveProject()).toBe(true)
    expect(backend.files.get(FILE)).not.toMatch(/Augusta|ada@example/)
    expect('contact' in onDisk()).toBe(false)
    expect(getResolvedContact()).toMatchObject({ legalName: 'Augusta Ada King', email: 'ada@example.com' })

    setContactOverride({ email: 'book@example.com' })
    expect(await saveProject()).toBe(true)
    expect(onDisk().contact).toEqual({ email: 'book@example.com' })
    expect(backend.files.get(FILE)).not.toMatch(/Augusta/)
    expect(getResolvedContact()).toMatchObject({ legalName: 'Augusta Ada King', email: 'book@example.com' })

    await launch()
    await reopen()
    expect(getContactOverride()).toEqual({ email: 'book@example.com' })

    setContactOverride({ email: '' })
    expect(getContactOverride()).toEqual({})
    expect(await saveProject()).toBe(true)
    expect('contact' in onDisk()).toBe(false)
    useStore.getState().preferencesActions.set('profileLegalName', '')
    useStore.getState().preferencesActions.set('profileEmail', '')
  })

  it('remembers the last output folder', async () => {
    await createProject()
    setLastOutputFolder('/exports')
    expect(await saveProject()).toBe(true)
    expect(onDisk().settings.lastOutputFolder).toBe('/exports')
  })

  it('a change that sets what is already set is not a change', async () => {
    await createProject()
    editor.update(textDoc('x'))
    expect(await saveProject()).toBe(true)
    updateManuscriptSettings({ sceneBreak: '#' })
    expect(editor.isDirty()).toBe(false)
    expect(backend.files.has(FILE)).toBe(false)
  })

  it('a damaged file loads as the defaults, is left alone until the user changes a setting, then copied aside', async () => {
    await createProject()
    backend.files.set(FILE, '{ not json')
    await launch()
    await reopen()
    expect(getManuscriptSettings().preset).toBe('standard')
    expect(useStore.getState().project.sideFileWarning).toMatch(/export\.json/)
    editor.update(textDoc('typing'))
    expect(await saveProject()).toBe(true)
    expect(backend.files.get(FILE)).toBe('{ not json')
    updateManuscriptSettings({ sceneBreak: '***' })
    expect(await saveProject()).toBe(true)
    expect(onDisk().settings.sceneBreak).toBe('***')
    expect([...backend.files.keys()].some((k) => /export\.damaged-.*\.json$/.test(k))).toBe(true)
  })

  it('a file from a newer Novel is used as far as understood, guarded, and its unknown keys survive', async () => {
    await createProject()
    backend.files.set(FILE, JSON.stringify({ version: 9, future: { a: 1 }, settings: { sceneBreak: '***', futureOption: 'x' } }))
    await launch()
    await reopen()
    expect(getManuscriptSettings().sceneBreak).toBe('***')
    expect(useStore.getState().project.sideFileWarning).toMatch(/newer version/)
    updateManuscriptSettings({ endMarker: 'end' })
    expect(await saveProject()).toBe(true)
    expect(onDisk()).toMatchObject({ version: 1, future: { a: 1 }, settings: { futureOption: 'x', sceneBreak: '***', endMarker: 'end' } })
    expect([...backend.files.keys()].some((k) => /export\.newer-.*\.json$/.test(k))).toBe(true)
  })

  it('opening another project resets to its own settings (none: defaults)', async () => {
    await createProject()
    updateManuscriptSettings({ sceneBreak: '***' })
    expect(await saveProject()).toBe(true)
    __resetExportSettingsForTests()
    expect(getManuscriptSettings().sceneBreak).toBe('#')
  })

  it('Save a Copy carries it', async () => {
    await createProject()
    updateManuscriptSettings({ sceneBreak: '***' })
    backend.dirs.add('/books/copy')
    backend.pick = '/books/copy'
    expect(await saveProjectCopy()).toBe(true)
    expect(JSON.parse(backend.files.get('/books/copy/export.json')!).settings.sceneBreak).toBe('***')
  })
})
