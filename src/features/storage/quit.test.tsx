import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { createMemoryDocumentProvider, registerDocumentProvider, type DocJSON } from '@/shared/document'
import { useStore } from '@/shared/store'
import { initialProjectState } from '@/shared/store/project-slice'
import { backend } from '@/test-utils/fake-tauri'

vi.mock('@tauri-apps/api/core', async () => (await import('@/test-utils/fake-tauri')).coreModule)
vi.mock('@tauri-apps/plugin-dialog', async () => (await import('@/test-utils/fake-tauri')).dialogModule)
vi.mock('@tauri-apps/plugin-sql', async () => (await import('@/test-utils/fake-tauri')).sqlModule)

const win = vi.hoisted(() => ({
  closeHandler: null as null | ((e: { preventDefault: () => void }) => Promise<void>),
  destroy: null as unknown as () => Promise<void>,
}))
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }))
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    onCloseRequested: async (cb: typeof win.closeHandler) => {
      win.closeHandler = cb
      return () => {}
    },
    destroy: () => win.destroy(),
  }),
}))

import { autosaveNow, newProject, useStorageIntegration } from './index'
import { saveStatusText as saveStatusTextForTests } from './SaveStatusIndicator'
import { __resetAutosaveForTests } from './autosave'
import { __resetStorageForTests } from './project'
import { __resetWriteLockForTests } from './write-lock'

const ROOT = '/books/novel'
const RECOVERY = `${ROOT}/.recovery/manuscript.json`
const textDoc = (text: string): DocJSON => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
})

let editor = createMemoryDocumentProvider()
let unregister = () => {}
const destroy = vi.fn(async () => {})

function Host() {
  useStorageIntegration()
  return null
}

async function quit() {
  await win.closeHandler!({ preventDefault: () => {} })
}

beforeEach(async () => {
  backend.reset()
  await __resetAutosaveForTests()
  await __resetStorageForTests()
  __resetWriteLockForTests()
  useStore.setState({ project: initialProjectState })
  unregister()
  editor = createMemoryDocumentProvider()
  unregister = registerDocumentProvider(editor)
  destroy.mockClear()
  win.destroy = destroy
  render(<Host />)
  backend.dirs.add(ROOT)
  backend.pick = ROOT
  expect(await newProject()).toBe(true)
  editor.update(textDoc('unsaved'))
  expect(await autosaveNow()).toBe('written')
})

afterEach(() => {
  cleanup()
  unregister()
})

describe('quit', () => {
  it('"Don\'t Save" quit clears recovery data, then closes', async () => {
    backend.answer = "Don't Save"
    await quit()
    expect(backend.files.has(RECOVERY)).toBe(false)
    expect(destroy).toHaveBeenCalledOnce()
  })

  it('Save quit saves and clears recovery data, then closes', async () => {
    backend.answer = 'Save'
    await quit()
    expect(JSON.parse(backend.files.get(`${ROOT}/manuscript.json`)!)).toEqual(textDoc('unsaved'))
    expect(backend.files.has(RECOVERY)).toBe(false)
    expect(destroy).toHaveBeenCalledOnce()
  })

  it('Cancel keeps the window and the recovery data', async () => {
    backend.answer = 'Cancel'
    await quit()
    expect(backend.files.has(RECOVERY)).toBe(true)
    expect(destroy).not.toHaveBeenCalled()
  })

  it('a clean quit removes leftover recovery data', async () => {
    editor.markClean()
    await quit()
    expect(backend.messages).toEqual([])
    expect(backend.files.has(RECOVERY)).toBe(false)
    expect(destroy).toHaveBeenCalledOnce()
  })

  it('status text mentions the backup while changes are unsaved', () => {
    const base = { path: '/p', title: 't', dirty: true, saveStatus: 'idle' as const }
    expect(saveStatusTextForTests({ ...base, backedUp: true })).toBe('Unsaved changes (backed up)')
  })
})
