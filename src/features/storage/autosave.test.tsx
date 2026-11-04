import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createMemoryDocumentProvider, registerDocumentProvider, type DocJSON } from '@/shared/document'
import { useStore } from '@/shared/store'
import { initialProjectState } from '@/shared/store/project-slice'
import { backend } from '@/test-utils/fake-tauri'

vi.mock('@tauri-apps/api/core', async () => (await import('@/test-utils/fake-tauri')).coreModule)
vi.mock('@tauri-apps/plugin-dialog', async () => (await import('@/test-utils/fake-tauri')).dialogModule)
vi.mock('@tauri-apps/plugin-sql', async () => (await import('@/test-utils/fake-tauri')).sqlModule)

import {
  AUTOSAVE_INTERVAL_MS,
  autosaveNow,
  confirmUnsavedChanges,
  discardRecovery,
  hasPendingRecovery,
  loadRecentProjects,
  newProject,
  openProject,
  RecoveryStatus,
  reopenRecoveryPrompt,
  restoreRecovery,
  SaveStatusIndicator,
  saveProject,
  startAutosave,
  updateProjectDetails,
} from './index'
import { __resetAutosaveForTests } from './autosave'
import { __resetStorageForTests, clearRecoveryData, offerReopenAfterCrash, unrestoredNotice } from './project'
import { parseRecovery, unrestoredFileName } from './recovery'
import { RecoveryDialog } from './RecoveryDialog'
import { TooltipProvider } from '@/shared/ui'
import { __resetWriteLockForTests } from './write-lock'

const ROOT = '/books/novel'
const RECOVERY = `${ROOT}/.recovery/manuscript.json`
const MANUSCRIPT = `${ROOT}/manuscript.json`

const textDoc = (text: string): DocJSON => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
})
const recoveryText = () => parseRecovery(backend.files.get(RECOVERY)!)?.doc.content?.[0].content?.[0].text
const recoveryWrites = () => backend.writes.filter((w) => w === RECOVERY).length
const project = () => useStore.getState().project

const metaOnDisk = () => JSON.parse(backend.files.get(`${ROOT}/project.json`)!) as { id: string; updatedAt: string }
const unrestoredPath = (savedAt: string) => `${ROOT}/.recovery/${unrestoredFileName(savedAt)}`
const unrestoredFiles = () => [...backend.files.keys()].filter((k) => k.includes('/.recovery/unrestored-'))

/** Put a recovery file on disk directly; returns its text. */
function plantSnapshot(f: { projectId: string; savedAt: string; baseUpdatedAt?: string; doc: DocJSON }): string {
  backend.dirs.add(`${ROOT}/.recovery`)
  const text = JSON.stringify({ format: 'novel-recovery', version: 1, docVersion: 1, ...f })
  backend.files.set(RECOVERY, text)
  return text
}

function renderDialog() {
  return render(
    <TooltipProvider>
      <RecoveryDialog />
    </TooltipProvider>,
  )
}

/** Open a project with an unanswered snapshot ("Decide later"): returns that snapshot's savedAt. */
async function withUnansweredSnapshot(text = 'precious crash text'): Promise<string> {
  await createProject()
  editor.update(textDoc(text))
  await vi.advanceTimersByTimeAsync(AUTOSAVE_INTERVAL_MS)
  const savedAt = parseRecovery(backend.files.get(RECOVERY)!)!.savedAt
  await launch()
  await reopen()
  expect(hasPendingRecovery()).toBe(true)
  useStore.getState().projectActions.dismissRecoveryPrompt() // Escape / X
  return savedAt
}

let editor = createMemoryDocumentProvider()
let unregister = () => {}

/** Simulate an app launch: fresh in-memory state, same disk + recent file. */
async function launch() {
  await __resetAutosaveForTests()
  await __resetStorageForTests()
  __resetWriteLockForTests()
  useStore.setState({ project: initialProjectState })
  useStore.getState().bookActions.resetBook()
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

/** Reopen ROOT from the recent list (as after a restart). */
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

describe('autosave cadence', () => {
  it('writes a snapshot 30 s after the first unsaved change, never over manuscript.json', async () => {
    await createProject()
    const manuscriptBefore = backend.files.get(MANUSCRIPT)
    editor.update(textDoc('first'))
    await vi.advanceTimersByTimeAsync(AUTOSAVE_INTERVAL_MS - 1)
    expect(backend.files.has(RECOVERY)).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(recoveryText()).toBe('first')
    expect(backend.files.get(MANUSCRIPT)).toBe(manuscriptBefore)
    expect(backend.dirs.has(`${ROOT}/.recovery`)).toBe(true)
    const snap = parseRecovery(backend.files.get(RECOVERY)!)!
    expect(snap).toMatchObject({ format: 'novel-recovery', version: 3, docVersion: editor.getDocVersion() })
    expect(project().lastBackupAt).not.toBeNull()
    expect(editor.isDirty()).toBe(true)
  })

  it('throttles: continuous typing gets one snapshot per 30 s, not zero and not one per keystroke', async () => {
    await createProject()
    const getDocJSON = vi.spyOn(editor, 'getDocJSON')
    for (let s = 1; s <= 95; s++) {
      editor.update(textDoc(`word ${s}`))
      await vi.advanceTimersByTimeAsync(1000)
    }
    expect(recoveryWrites()).toBe(3) // at ~30, ~61, ~92 s
    // The document is serialized only on timer ticks, never per keystroke.
    expect(getDocJSON).toHaveBeenCalledTimes(3)
  })

  it('does nothing while the document is clean or no project is open', async () => {
    editor.update(textDoc('no project yet'))
    await vi.advanceTimersByTimeAsync(AUTOSAVE_INTERVAL_MS * 3)
    expect(backend.writes).toEqual([])

    backend.answer = "Don't Save" // New Project asks about the unsaved untitled text
    await createProject()
    await vi.advanceTimersByTimeAsync(AUTOSAVE_INTERVAL_MS * 3)
    expect(recoveryWrites()).toBe(0)
  })

  it('does not rewrite an unchanged snapshot', async () => {
    await createProject()
    editor.update(textDoc('once'))
    await vi.advanceTimersByTimeAsync(AUTOSAVE_INTERVAL_MS)
    expect(await autosaveNow()).toBe('skipped')
    expect(recoveryWrites()).toBe(1)
  })
})

describe('autosave and manual save', () => {
  it('never overlaps a manual save: the snapshot waits, then is skipped because the save made the doc clean', async () => {
    await createProject()
    editor.update(textDoc('saving'))
    let release!: () => void
    backend.writeGate = (path) =>
      path === MANUSCRIPT ? new Promise<void>((r) => (release = r)) : Promise.resolve()
    const save = saveProject()
    await vi.advanceTimersByTimeAsync(0)
    const snapshot = autosaveNow()
    await vi.advanceTimersByTimeAsync(0)
    expect(backend.files.has(RECOVERY)).toBe(false) // still waiting behind the save
    release()
    expect(await save).toBe(true)
    expect(await snapshot).toBe('skipped')
    expect(recoveryWrites()).toBe(0)
  })

  it('a snapshot queued behind a save still protects edits made during the save', async () => {
    await createProject()
    editor.update(textDoc('v1'))
    let release!: () => void
    backend.writeGate = (path) =>
      path === MANUSCRIPT ? new Promise<void>((r) => (release = r)) : Promise.resolve()
    const save = saveProject()
    await vi.advanceTimersByTimeAsync(0)
    editor.update(textDoc('v2 typed during save'))
    const snapshot = autosaveNow()
    release()
    await save
    expect(await snapshot).toBe('written')
    const order = backend.writes.filter((w) => w === MANUSCRIPT || w === RECOVERY)
    expect(order.at(-1)).toBe(RECOVERY)
    expect(recoveryText()).toBe('v2 typed during save')
  })

  it('a clean manual save clears recovery data and the backup state', async () => {
    await createProject()
    editor.update(textDoc('draft'))
    await vi.advanceTimersByTimeAsync(AUTOSAVE_INTERVAL_MS)
    expect(backend.files.has(RECOVERY)).toBe(true)
    expect(await saveProject()).toBe(true)
    expect(backend.files.has(RECOVERY)).toBe(false)
    expect(project().lastBackupAt).toBeNull()
  })
})

describe('crash recovery', () => {
  it('ACCEPTANCE: force-quit within 30 s of the last autosave, reopen, Restore recovers text up to that autosave', async () => {
    await createProject()
    editor.update(textDoc('Chapter one, saved by autosave'))
    await vi.advanceTimersByTimeAsync(AUTOSAVE_INTERVAL_MS)
    editor.update(textDoc('typed after the last autosave'))
    await vi.advanceTimersByTimeAsync(20_000)

    await launch() // force quit: no save, no close handler
    await reopen()
    expect(project().recoveryPrompt).toMatchObject({ kind: 'restore' })
    expect(hasPendingRecovery()).toBe(true)
    expect(await restoreRecovery()).toBe(true)
    expect(editor.getDocJSON()).toEqual(textDoc('Chapter one, saved by autosave'))
    expect(editor.isDirty()).toBe(true) // user must save
    expect(project().recoveryPrompt).toBeNull()
    expect(backend.files.has(RECOVERY)).toBe(true) // kept until saved: survives a second crash

    expect(await saveProject()).toBe(true)
    expect(JSON.parse(backend.files.get(MANUSCRIPT)!)).toEqual(textDoc('Chapter one, saved by autosave'))
    expect(backend.files.has(RECOVERY)).toBe(false)
  })

  it('Discard deletes the backup and keeps the saved manuscript', async () => {
    await createProject()
    editor.update(textDoc('lost on purpose'))
    await vi.advanceTimersByTimeAsync(AUTOSAVE_INTERVAL_MS)
    await launch()
    await reopen()
    await discardRecovery()
    expect(backend.files.has(RECOVERY)).toBe(false)
    expect(editor.getDocJSON()).toEqual({ type: 'doc', content: [{ type: 'paragraph' }] })
    expect(editor.isDirty()).toBe(false)
    expect(project().recoveryPrompt).toBeNull()
  })

  it('offers by base match, not wall clock: a snapshot "older" than the save (clock skew) is still offered', async () => {
    await createProject()
    const meta = metaOnDisk()
    plantSnapshot({
      projectId: meta.id,
      savedAt: new Date(Date.parse(meta.updatedAt) - 3_600_000).toISOString(), // clock went back an hour
      baseUpdatedAt: meta.updatedAt,
      doc: textDoc('written while the clock was wrong'),
    })
    await launch()
    await reopen()
    expect(project().recoveryPrompt).toMatchObject({ kind: 'restore' })
    expect(backend.files.has(RECOVERY)).toBe(true)
  })

  it('equal savedAt and updatedAt: decided by the base, and offered', async () => {
    await createProject()
    const meta = metaOnDisk()
    plantSnapshot({ projectId: meta.id, savedAt: meta.updatedAt, baseUpdatedAt: meta.updatedAt, doc: textDoc('same ms') })
    await launch()
    await reopen()
    expect(project().recoveryPrompt).toMatchObject({ kind: 'restore' })
  })

  it('a snapshot taken on top of a different save is not offered and is moved aside, never deleted', async () => {
    await createProject()
    const meta = metaOnDisk()
    const savedAt = new Date(Date.parse(meta.updatedAt) + 3_600_000).toISOString() // "newer" by the clock
    const text = plantSnapshot({ projectId: meta.id, savedAt, baseUpdatedAt: '2000-01-01T00:00:00.000Z', doc: textDoc('old base') })
    await launch()
    await reopen()
    expect(project().recoveryPrompt).toBeNull()
    expect(backend.files.has(RECOVERY)).toBe(false)
    expect(backend.files.get(unrestoredPath(savedAt))).toBe(text)
  })

  it('another project\'s snapshot (projectId mismatch) is not offered and is moved aside', async () => {
    await createProject()
    const meta = metaOnDisk()
    const savedAt = new Date().toISOString()
    plantSnapshot({ projectId: 'someone-else', savedAt, baseUpdatedAt: meta.updatedAt, doc: textDoc('foreign') })
    await launch()
    await reopen()
    expect(project().recoveryPrompt).toBeNull()
    expect(backend.files.has(unrestoredPath(savedAt))).toBe(true)
  })

  it('without baseUpdatedAt, falls back to savedAt; when not newer it is kept aside, not deleted', async () => {
    await createProject()
    const meta = metaOnDisk()
    const savedAt = new Date(Date.parse(meta.updatedAt) - 1000).toISOString()
    plantSnapshot({ projectId: meta.id, savedAt, doc: textDoc('legacy') })
    await launch()
    await reopen()
    expect(project().recoveryPrompt).toBeNull()
    expect(backend.files.has(unrestoredPath(savedAt))).toBe(true)
  })

  it('a newer snapshot identical to the manuscript is not offered', async () => {
    await createProject()
    editor.update(textDoc('same'))
    await saveProject()
    editor.update(textDoc('same')) // dirty again, same content
    await vi.advanceTimersByTimeAsync(AUTOSAVE_INTERVAL_MS)
    expect(backend.files.has(RECOVERY)).toBe(true)
    await launch()
    await reopen()
    expect(project().recoveryPrompt).toBeNull()
    expect(backend.files.has(RECOVERY)).toBe(false)
  })

  it('a damaged recovery file is ignored (not deleted) and the project opens', async () => {
    await createProject()
    backend.dirs.add(`${ROOT}/.recovery`)
    backend.files.set(RECOVERY, '{not json')
    await launch()
    await reopen()
    expect(project().recoveryPrompt).toBeNull()
    expect(project().path).toBe(ROOT)
  })

  it('"Don\'t Save" clears recovery data and the discarded content is not snapshotted again', async () => {
    await createProject()
    editor.update(textDoc('discard me'))
    await vi.advanceTimersByTimeAsync(AUTOSAVE_INTERVAL_MS)
    backend.answer = "Don't Save"
    expect(await confirmUnsavedChanges('closing')).toBe(true)
    expect(backend.files.has(RECOVERY)).toBe(false)
    expect(await autosaveNow()).toBe('skipped')
    expect(backend.files.has(RECOVERY)).toBe(false)
    // New edits are protected again.
    editor.update(textDoc('changed my mind'))
    await vi.advanceTimersByTimeAsync(AUTOSAVE_INTERVAL_MS)
    expect(recoveryText()).toBe('changed my mind')
  })

  it('clean quit: clearRecoveryData waits for an in-flight snapshot, then deletes', async () => {
    await createProject()
    editor.update(textDoc('x'))
    let release!: () => void
    backend.writeGate = (path) => (path === RECOVERY ? new Promise<void>((r) => (release = r)) : Promise.resolve())
    const snapshot = autosaveNow()
    await vi.advanceTimersByTimeAsync(0)
    const cleared = clearRecoveryData()
    release()
    await snapshot
    await cleared
    expect(backend.files.has(RECOVERY)).toBe(false)
  })

  it('at startup, offers to reopen the last project when it has recovery data', async () => {
    await createProject()
    editor.update(textDoc('crash'))
    await vi.advanceTimersByTimeAsync(AUTOSAVE_INTERVAL_MS)
    await launch()
    await offerReopenAfterCrash(await loadRecentProjects())
    expect(project().recoveryPrompt).toEqual({ kind: 'reopen', path: ROOT, name: 'novel' })

    // Without recovery data: no prompt.
    backend.files.delete(RECOVERY)
    await launch()
    await offerReopenAfterCrash(await loadRecentProjects())
    expect(project().recoveryPrompt).toBeNull()
  })
})

describe('book details and crash recovery', () => {
  // project.json `updatedAt` is the last save (docs/project-format.md); a details edit is not a save,
  // so it must not change the base a recovery snapshot is matched against.
  it('REGRESSION: create, edit, autosave, edit book details, crash: reopen still offers Restore', async () => {
    await createProject()
    editor.update(textDoc('typed, then the author was set'))
    await vi.advanceTimersByTimeAsync(AUTOSAVE_INTERVAL_MS)
    const updatedAt = metaOnDisk().updatedAt
    expect(await updateProjectDetails({ title: 'The Long Road', author: 'Ada Quill' })).toBe(true)
    expect(metaOnDisk()).toMatchObject({ title: 'The Long Road', author: 'Ada Quill', updatedAt })

    await launch() // crash
    await offerReopenAfterCrash(await loadRecentProjects())
    expect(project().recoveryPrompt).toMatchObject({ kind: 'reopen', path: ROOT })
    await reopen()
    expect(project().recoveryPrompt).toMatchObject({ kind: 'restore' })
    expect(unrestoredFiles()).toEqual([])
    expect(await restoreRecovery()).toBe(true)
    expect(editor.getDocJSON()).toEqual(textDoc('typed, then the author was set'))
    expect(project()).toMatchObject({ title: 'The Long Road', author: 'Ada Quill' })
  })

  it('REGRESSION: an unanswered backup ("Decide later") is still offered after a book details edit and a crash', async () => {
    const savedAt = await withUnansweredSnapshot('decide later text')
    expect(await updateProjectDetails({ author: 'Ada Quill' })).toBe(true)
    expect(hasPendingRecovery()).toBe(true)
    await launch() // crash
    await reopen()
    expect(project().recoveryPrompt).toMatchObject({ kind: 'restore', savedAt })
    expect(unrestoredFiles()).toEqual([])
    expect(await restoreRecovery()).toBe(true)
    expect(editor.getDocJSON()).toEqual(textDoc('decide later text'))
  })

  it('a real save after a details edit still moves the base forward', async () => {
    await createProject()
    expect(await updateProjectDetails({ author: 'Ada Quill' })).toBe(true)
    const before = metaOnDisk().updatedAt
    await vi.advanceTimersByTimeAsync(5)
    editor.update(textDoc('saved'))
    expect(await saveProject()).toBe(true)
    expect(metaOnDisk().updatedAt).not.toBe(before)
    expect(metaOnDisk()).toMatchObject({ author: 'Ada Quill' })
  })
})

describe('autosave errors', () => {
  it('disk full: non-blocking warning, retries after 5 s, 15 s, then recovers and clears the warning', async () => {
    await createProject()
    let failing = true
    backend.failWrite = (path) =>
      failing && path.startsWith(`${ROOT}/.recovery`)
        ? { kind: 'disk_full', message: 'There is not enough space on the disk. (os error 112)' }
        : null
    editor.update(textDoc('important'))
    await vi.advanceTimersByTimeAsync(AUTOSAVE_INTERVAL_MS)
    expect(project().backupWarning).toBe('Autosave failed: the disk is full. Retrying in 5 s.')
    expect(backend.messages).toEqual([]) // no modal
    await vi.advanceTimersByTimeAsync(5_000)
    expect(project().backupWarning).toBe('Autosave failed: the disk is full. Retrying in 15 s.')
    await vi.advanceTimersByTimeAsync(15_000)
    expect(project().backupWarning).toBe('Autosave failed: the disk is full. Retrying in 30 s.')
    failing = false
    await vi.advanceTimersByTimeAsync(30_000)
    expect(project().backupWarning).toBeNull()
    expect(recoveryText()).toBe('important')
    expect(backend.messages).toEqual([])
  })

  it('read-only folder maps to a friendly warning; the status bar shows it', async () => {
    await createProject()
    backend.failWrite = (path) =>
      path.startsWith(`${ROOT}/.recovery`) ? { kind: 'read_only', message: 'Read-only file system (os error 30)' } : null
    editor.update(textDoc('x'))
    await vi.advanceTimersByTimeAsync(AUTOSAVE_INTERVAL_MS)
    expect(project().backupWarning).toBe('Autosave failed: the project folder is read-only. Retrying in 5 s.')
    render(<SaveStatusIndicator />)
    expect(screen.getByTestId('autosave-warning')).toHaveTextContent('read-only')
  })

  it('manual save on a full disk shows the friendly message', async () => {
    await createProject()
    backend.failWrite = () => ({ kind: 'disk_full', message: 'No space left on device (os error 28)' })
    editor.update(textDoc('x'))
    expect(await saveProject()).toBe(false)
    expect(project().saveError).toMatch(/disk is full/)
  })
})

describe('recovery dialog', () => {
  it('offers Restore and Discard with control ids; Restore loads the backup', async () => {
    await createProject()
    editor.update(textDoc('from backup'))
    await vi.advanceTimersByTimeAsync(AUTOSAVE_INTERVAL_MS)
    await launch()
    await reopen()
    renderDialog()
    const restore = screen.getByRole('button', { name: 'Restore' })
    expect(restore).toHaveAttribute('data-control-id', 'recovery.restore')
    expect(screen.getByRole('button', { name: 'Discard Backup' })).toHaveAttribute('data-control-id', 'recovery.discard')
    fireEvent.click(restore)
    await vi.advanceTimersByTimeAsync(0)
    expect(editor.getDocJSON()).toEqual(textDoc('from backup'))
    expect(editor.isDirty()).toBe(true)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('closing the dialog decides nothing: the backup is kept', async () => {
    await createProject()
    editor.update(textDoc('keep'))
    await vi.advanceTimersByTimeAsync(AUTOSAVE_INTERVAL_MS)
    await launch()
    await reopen()
    renderDialog()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    await vi.advanceTimersByTimeAsync(0)
    expect(project().recoveryPrompt).toBeNull()
    expect(hasPendingRecovery()).toBe(true)
    expect(backend.files.has(RECOVERY)).toBe(true)
  })
})

describe('unanswered snapshot ("Decide later") is never destroyed', () => {
  it('the next autosave moves it aside before writing a new snapshot', async () => {
    const savedAt = await withUnansweredSnapshot()
    const oldText = backend.files.get(RECOVERY)
    editor.update(textDoc('new typing'))
    await vi.advanceTimersByTimeAsync(AUTOSAVE_INTERVAL_MS)
    expect(backend.files.get(unrestoredPath(savedAt))).toBe(oldText)
    expect(recoveryText()).toBe('new typing')
    expect(hasPendingRecovery()).toBe(false)
  })

  it('a clean Save moves it aside instead of deleting it', async () => {
    const savedAt = await withUnansweredSnapshot()
    editor.update(textDoc('saved instead'))
    expect(await saveProject()).toBe(true)
    expect(backend.files.has(RECOVERY)).toBe(false)
    expect(parseRecovery(backend.files.get(unrestoredPath(savedAt))!)!.doc).toEqual(textDoc('precious crash text'))
  })

  it('"Don\'t Save" moves it aside instead of deleting it', async () => {
    const savedAt = await withUnansweredSnapshot()
    editor.update(textDoc('thrown away'))
    backend.answer = "Don't Save"
    expect(await confirmUnsavedChanges('closing')).toBe(true)
    expect(backend.files.has(RECOVERY)).toBe(false)
    expect(backend.files.has(unrestoredPath(savedAt))).toBe(true)
  })

  it('if it cannot be moved aside, the new snapshot is not written over it (warning + retry)', async () => {
    await withUnansweredSnapshot()
    const oldText = backend.files.get(RECOVERY)
    backend.failWrite = (path) => (path.includes('unrestored-') ? { kind: 'disk_full', message: 'full' } : null)
    editor.update(textDoc('new typing'))
    await vi.advanceTimersByTimeAsync(AUTOSAVE_INTERVAL_MS)
    expect(backend.files.get(RECOVERY)).toBe(oldText)
    expect(project().backupWarning).toMatch(/disk is full/)
  })

  it('an explicit Discard Backup deletes it without keeping a copy', async () => {
    await createProject()
    editor.update(textDoc('discard'))
    await vi.advanceTimersByTimeAsync(AUTOSAVE_INTERVAL_MS)
    await launch()
    await reopen()
    await discardRecovery()
    expect(backend.files.has(RECOVERY)).toBe(false)
    expect(unrestoredFiles()).toEqual([])
  })
})

describe('"Decide later" stays visible and reversible', () => {
  it('the store mirrors the unanswered backup, the status bar re-opens the prompt, and a later snapshot sets it aside with a note', async () => {
    const savedAt = await withUnansweredSnapshot()
    expect(project().recoveryPrompt).toBeNull()
    expect(project().pendingRecoveryAt).toBe(savedAt)
    render(
      <TooltipProvider>
        <RecoveryStatus />
      </TooltipProvider>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Backup available — Restore…' }))
    expect(project().recoveryPrompt).toEqual({ kind: 'restore', savedAt })
    // While the prompt is up, the status-bar control is hidden (the prompt is the control).
    expect(screen.queryByRole('button', { name: 'Backup available — Restore…' })).toBeNull()
    act(() => useStore.getState().projectActions.dismissRecoveryPrompt())
    expect(reopenRecoveryPrompt()).toBe(true)
    act(() => useStore.getState().projectActions.dismissRecoveryPrompt())

    editor.update(textDoc('new typing'))
    await act(() => vi.advanceTimersByTimeAsync(AUTOSAVE_INTERVAL_MS))
    expect(backend.files.has(unrestoredPath(savedAt))).toBe(true)
    expect(project().pendingRecoveryAt).toBeNull()
    expect(reopenRecoveryPrompt()).toBe(false)
    expect(screen.queryByRole('button', { name: 'Backup available — Restore…' })).toBeNull()
    expect(screen.getByTestId('recovery-notice')).toHaveTextContent(".recovery folder")
  })

  it('Restore and Discard clear the status-bar control', async () => {
    await withUnansweredSnapshot()
    await restoreRecovery()
    expect(project().pendingRecoveryAt).toBeNull()
    backend.reset()
    await launch()
    await withUnansweredSnapshot()
    await discardRecovery()
    expect(project().pendingRecoveryAt).toBeNull()
  })

  it('on open, set-aside unrestored-* backups are mentioned once in the status bar (no dialog)', async () => {
    await createProject()
    backend.dirs.add(`${ROOT}/.recovery`)
    backend.files.set(unrestoredPath('2026-01-01T00:00:00.000Z'), '{}')
    backend.files.set(unrestoredPath('2026-01-02T00:00:00.000Z'), '{}')
    await launch()
    await reopen()
    expect(project().recoveryPrompt).toBeNull()
    expect(project().recoveryNotice).toBe(unrestoredNotice(2))
    expect(project().recoveryNotice).toMatch(/2 older backups are kept in this project's .recovery folder/)
    await launch()
    backend.files.delete(unrestoredPath('2026-01-01T00:00:00.000Z'))
    await reopen()
    expect(project().recoveryNotice).toBe('1 older backup is kept in this project\'s .recovery folder.')
  })

  it('a project without set-aside backups shows no note', async () => {
    await createProject()
    await launch()
    await reopen()
    expect(project().recoveryNotice).toBeNull()
  })
})

describe('recovery details', () => {
  it('after Restore the status shows the work as backed up (lastBackupAt = snapshot time)', async () => {
    await createProject()
    editor.update(textDoc('b'))
    await vi.advanceTimersByTimeAsync(AUTOSAVE_INTERVAL_MS)
    const savedAt = parseRecovery(backend.files.get(RECOVERY)!)!.savedAt
    await launch()
    await reopen()
    await restoreRecovery()
    expect(project().lastBackupAt).toBe(Date.parse(savedAt))
  })

  it('startup offer uses the same rule as open: a snapshot of a different save is not offered', async () => {
    await createProject()
    const meta = metaOnDisk()
    plantSnapshot({ projectId: meta.id, savedAt: new Date().toISOString(), baseUpdatedAt: 'other', doc: textDoc('x') })
    await launch()
    await offerReopenAfterCrash(await loadRecentProjects())
    expect(project().recoveryPrompt).toBeNull()
    plantSnapshot({ projectId: 'other-project', savedAt: new Date().toISOString(), baseUpdatedAt: meta.updatedAt, doc: textDoc('x') })
    await offerReopenAfterCrash(await loadRecentProjects())
    expect(project().recoveryPrompt).toBeNull()
  })

  it('Windows access denied (file in use or read-only) gets its own wording', async () => {
    await createProject()
    backend.failWrite = (path) =>
      path.startsWith(`${ROOT}/.recovery`) ? { kind: 'permission_denied', message: 'Access is denied. (os error 5)' } : null
    editor.update(textDoc('x'))
    await vi.advanceTimersByTimeAsync(AUTOSAVE_INTERVAL_MS)
    expect(project().backupWarning).toBe(
      'Autosave failed: could not write (folder read-only or file in use). Retrying in 5 s.',
    )
    backend.failWrite = () => ({ kind: 'permission_denied', message: 'Access is denied. (os error 5)' })
    expect(await saveProject()).toBe(false)
    expect(project().saveError).toMatch(/read-only, or the file is in use by another program/)
  })
})
