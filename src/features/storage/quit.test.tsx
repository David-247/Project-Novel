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
  listeners: new Map<string, (e: { payload: unknown }) => void>(),
}))
vi.mock('@tauri-apps/api/event', () => ({
  listen: async (name: string, cb: (e: { payload: unknown }) => void) => {
    win.listeners.set(name, cb)
    return () => {}
  },
}))
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    onCloseRequested: async (cb: typeof win.closeHandler) => {
      win.closeHandler = cb
      return () => {}
    },
    destroy: () => win.destroy(),
  }),
}))

import { autosaveNow, MENU_EVENTS, newProject, useStorageIntegration } from './index'
import { handleQuitRequest, prepareToExit } from './integration'
import { formatBackupTime, saveStatusText as saveStatusTextForTests } from './SaveStatusIndicator'
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

  it('if closing the window fails after the prompt, autosave keeps running', async () => {
    destroy.mockRejectedValueOnce(new Error('destroy failed'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.useFakeTimers()
    try {
      backend.answer = "Don't Save"
      await quit()
      expect(destroy).toHaveBeenCalledOnce()
      // Still open and still protected: the next edit arms the 30 s snapshot timer again.
      editor.update(textDoc('timer armed again'))
      await vi.advanceTimersByTimeAsync(30_000)
      expect(JSON.parse(backend.files.get(RECOVERY)!).doc).toEqual(textDoc('timer armed again'))
    } finally {
      vi.useRealTimers()
    }
  })

  it('status text gives the time of the last backup while changes are unsaved', () => {
    const base = { path: '/p', title: 't', dirty: true, saveStatus: 'idle' as const }
    const at = new Date(2026, 10, 3, 12, 4).getTime()
    expect(saveStatusTextForTests({ ...base, lastBackupAt: at })).toBe(`Unsaved changes · backed up ${formatBackupTime(at)}`)
    expect(formatBackupTime(at)).toMatch(/12.04/)
    expect(saveStatusTextForTests({ ...base, lastBackupAt: null })).toBe('Unsaved changes')
  })

  it('the Quit menu item / Cmd+Q / OS quit event is wired to the quit flow', async () => {
    backend.answer = "Don't Save"
    await vi.waitFor(() => expect(win.listeners.has(MENU_EVENTS.QUIT)).toBe(true))
    win.listeners.get(MENU_EVENTS.QUIT)!({ payload: null })
    await vi.waitFor(() => expect(backend.exits).toBe(1))
    expect(backend.messages[0].text).toMatch(/before quitting/)
    expect(backend.files.has(RECOVERY)).toBe(false)
  })

  it('Quit with "Save" saves, clears recovery data and exits', async () => {
    backend.answer = 'Save'
    await handleQuitRequest()
    expect(JSON.parse(backend.files.get(`${ROOT}/manuscript.json`)!)).toEqual(textDoc('unsaved'))
    expect(backend.files.has(RECOVERY)).toBe(false)
    expect(backend.exits).toBe(1)
  })

  it('Quit with "Cancel" does not exit and keeps recovery data', async () => {
    backend.answer = 'Cancel'
    await handleQuitRequest()
    expect(backend.exits).toBe(0)
    expect(backend.files.has(RECOVERY)).toBe(true)
  })

  it('close and quit requested together share one prompt', async () => {
    backend.answer = "Don't Save"
    const [a, b] = await Promise.all([prepareToExit('closing'), prepareToExit('quitting')])
    expect(a && b).toBe(true)
    expect(backend.messages).toHaveLength(1)
  })

  it('if the dialog plugin fails, quitting falls back to window.confirm and keeps the backup', async () => {
    backend.failDialog = true
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    await handleQuitRequest()
    expect(confirm).toHaveBeenCalledOnce()
    expect(backend.exits).toBe(1)
    // Changes were not saved and not explicitly discarded: the crash-recovery copy stays.
    expect(backend.files.has(RECOVERY)).toBe(true)
    confirm.mockRestore()
    err.mockRestore()
  })
})
