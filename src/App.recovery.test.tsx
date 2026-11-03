// Crash recovery through the SHIPPED wiring: the real editor (mounted Tiptap)
// seen by storage via App's editorDocumentProvider.
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDocJSON, getEditor, isDirty, NovelEditor, setDocJSON } from '@/features/editor'
import { installLayoutPolyfills } from '@/features/editor/jsdom-polyfills.test-util'
import { registerDocumentProvider } from '@/shared/document'
import { useStore } from '@/shared/store'
import { initialProjectState } from '@/shared/store/project-slice'
import { backend } from '@/test-utils/fake-tauri'

vi.mock('@tauri-apps/api/core', async () => (await import('@/test-utils/fake-tauri')).coreModule)
vi.mock('@tauri-apps/plugin-dialog', async () => (await import('@/test-utils/fake-tauri')).dialogModule)
vi.mock('@tauri-apps/plugin-sql', async () => (await import('@/test-utils/fake-tauri')).sqlModule)

import { editorDocumentProvider } from './App'
import { autosaveNow, loadRecentProjects, newProject, openProject, restoreRecovery } from '@/features/storage'
// Test-only resets (module state), as in the storage slice's own tests.
import { __resetAutosaveForTests, startAutosave } from '@/features/storage/autosave'
import { __resetStorageForTests } from '@/features/storage/project'
import { __resetWriteLockForTests } from '@/features/storage/write-lock'

const ROOT = '/books/real'
let unregister = () => {}

async function launch() {
  cleanup()
  await __resetAutosaveForTests()
  await __resetStorageForTests()
  __resetWriteLockForTests()
  useStore.setState({ project: initialProjectState })
  unregister()
  setDocJSON({ type: 'doc', content: [{ type: 'paragraph' }] })
  backend.active = backend.previous = null
  render(<NovelEditor />)
  unregister = registerDocumentProvider(editorDocumentProvider)
  startAutosave()
}

beforeAll(installLayoutPolyfills)
beforeEach(async () => {
  backend.reset()
  await launch()
})
afterEach(async () => {
  cleanup()
  unregister()
  await __resetAutosaveForTests()
})

describe('crash recovery with the real editor', () => {
  it('type -> autosave -> relaunch -> Restore: text is back and the editor is dirty', async () => {
    backend.dirs.add(ROOT)
    backend.pick = ROOT
    expect(await newProject()).toBe(true)

    act(() => {
      getEditor()!.commands.insertContent('Typed before the crash.')
    })
    expect(isDirty()).toBe(true)
    expect(await autosaveNow()).toBe('written')

    await launch() // force quit
    expect(JSON.stringify(getDocJSON())).not.toContain('Typed before the crash.')
    await loadRecentProjects()
    expect(await openProject(ROOT)).toBe(true)
    expect(useStore.getState().project.recoveryPrompt).toMatchObject({ kind: 'restore' })
    expect(isDirty()).toBe(false)

    let restored = false
    await act(async () => {
      restored = await restoreRecovery()
    })
    expect(restored).toBe(true)
    expect(JSON.stringify(getDocJSON())).toContain('Typed before the crash.')
    expect(isDirty()).toBe(true)
    expect(useStore.getState().editor.dirty).toBe(true)
    expect(useStore.getState().project.lastBackupAt).not.toBeNull()
  })
})
