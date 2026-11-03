import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryDocumentProvider, registerDocumentProvider, type DocJSON } from '@/shared/document'
import { useStore } from '@/shared/store'
import { initialProjectState } from '@/shared/store/project-slice'

// ---- Fake Tauri backend ------------------------------------------------------
const fs = vi.hoisted(() => ({ files: new Map<string, string>(), dirs: new Set<string>(), writes: [] as string[] }))
const recentFile = vi.hoisted(() => ({ text: null as string | null, menu: [] as unknown[] }))
const dialog = vi.hoisted(() => ({
  pick: null as string | null,
  messages: [] as { text: string; opts: unknown }[],
  answer: 'Cancel' as string,
}))
const sql = vi.hoisted(() => ({ executed: [] as string[], loads: [] as string[], failLoad: false }))

vi.mock('@tauri-apps/api/core', () => ({
  isTauri: () => true,
  invoke: vi.fn(async (cmd: string, args: Record<string, unknown> = {}) => {
    const path = args.path as string
    const parent = (p: string) => p.slice(0, p.lastIndexOf('/'))
    switch (cmd) {
      case 'storage_path_exists':
        return fs.files.has(path) || fs.dirs.has(path)
      case 'storage_read_text_file':
        if (!fs.files.has(path)) throw { kind: 'not_found', message: `${path}: not found` }
        return fs.files.get(path)
      case 'storage_write_file_atomic':
        if (!fs.dirs.has(parent(path))) throw { kind: 'not_found', message: 'Folder does not exist' }
        fs.files.set(path, args.contents as string)
        fs.writes.push(path)
        return null
      case 'storage_read_recent':
        return recentFile.text
      case 'storage_write_recent':
        recentFile.text = args.contents as string
        return null
      case 'storage_set_recent_menu':
        recentFile.menu = args.entries as unknown[]
        return null
      default:
        throw new Error(`unexpected command ${cmd}`)
    }
  }),
}))

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(async () => dialog.pick),
  message: vi.fn(async (text: string, opts: unknown) => {
    dialog.messages.push({ text, opts })
    return dialog.answer
  }),
}))

vi.mock('@tauri-apps/plugin-sql', () => ({
  default: {
    load: vi.fn(async (url: string) => {
      if (sql.failLoad) throw new Error('sqlite unavailable')
      sql.loads.push(url)
      return {
        execute: async (q: string) => {
          sql.executed.push(q)
          return { rowsAffected: 1 }
        },
        select: async () => [{ user_version: 0 }],
        close: async () => true,
      }
    }),
  },
}))

import {
  confirmUnsavedChanges,
  createProjectAt,
  getCurrentProjectPath,
  loadRecentProjects,
  newProject,
  onProjectOpened,
  openProject,
  saveProject,
} from './index'
import { __resetStorageForTests } from './project'

const textDoc = (text: string): DocJSON => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
})

let editor = createMemoryDocumentProvider()
let unregister = () => {}

beforeEach(async () => {
  await __resetStorageForTests()
  fs.files.clear()
  fs.dirs.clear()
  fs.writes.length = 0
  recentFile.text = null
  recentFile.menu = []
  dialog.pick = null
  dialog.messages.length = 0
  dialog.answer = 'Cancel'
  sql.executed.length = 0
  sql.loads.length = 0
  sql.failLoad = false
  useStore.setState({ project: initialProjectState })
  editor = createMemoryDocumentProvider()
  unregister = registerDocumentProvider(editor)
  fs.dirs.add('/books/novel')
})

afterEach(() => unregister())

describe('project storage', () => {
  it('creates, saves, reopens from recent with identical content', async () => {
    dialog.pick = '/books/novel'
    const opened = vi.fn()
    onProjectOpened(opened)
    expect(await newProject()).toBe(true)

    expect(fs.files.has('/books/novel/project.json')).toBe(true)
    expect(JSON.parse(fs.files.get('/books/novel/project.json')!)).toMatchObject({
      format: 'novel-project',
      schemaVersion: 1,
      title: 'novel',
    })
    expect(sql.loads).toEqual(['sqlite:/books/novel/index.sqlite'])
    expect(sql.executed.some((q) => q.includes('CREATE TABLE IF NOT EXISTS revisions'))).toBe(true)
    expect(opened).toHaveBeenCalledWith(expect.objectContaining({ path: '/books/novel' }))
    expect(getCurrentProjectPath()).toBe('/books/novel')

    // Write text, save.
    const content = textDoc('It was a dark and stormy night.')
    editor.update(content)
    expect(useStore.getState().project.dirty).toBe(false) // dirty tracking is wired by the hook, not here
    expect(await saveProject()).toBe(true)
    expect(editor.isDirty()).toBe(false)
    expect(useStore.getState().project.saveStatus).toBe('saved')
    expect(JSON.parse(fs.files.get('/books/novel/manuscript.json')!)).toEqual(content)
    expect(sql.executed.some((q) => /insert into "revisions"/i.test(q))).toBe(true)

    // "Quit": drop all in-memory state, keep the disk and the recent file.
    await __resetStorageForTests()
    useStore.setState({ project: initialProjectState })
    unregister()
    editor = createMemoryDocumentProvider()
    unregister = registerDocumentProvider(editor)

    const recent = await loadRecentProjects()
    expect(recent.map((r) => r.path)).toEqual(['/books/novel'])
    expect(recentFile.menu).toEqual([{ path: '/books/novel', label: 'novel (/books/novel)', missing: false }])

    expect(await openProject(recent[0].path)).toBe(true)
    expect(editor.getDocJSON()).toEqual(content)
    expect(editor.isDirty()).toBe(false)
    expect(dialog.messages).toEqual([])
  })

  it('shows an error dialog for a corrupted manuscript.json instead of crashing', async () => {
    await createProjectAt('/books/novel', textDoc('original'))
    fs.files.set('/books/novel/manuscript.json', '{"type":"doc","content":[{"type":"parag')
    await __resetStorageForTests()
    useStore.setState({ project: initialProjectState })

    expect(await openProject('/books/novel')).toBe(false)
    expect(dialog.messages).toHaveLength(1)
    expect(dialog.messages[0].text).toMatch(/manuscript\.json is damaged/)
    expect(dialog.messages[0].opts).toMatchObject({ kind: 'error', title: 'Could not open project' })
    expect(getCurrentProjectPath()).toBeNull()
  })

  it('reports a missing manuscript.json and a non-project folder', async () => {
    fs.files.set('/books/novel/project.json', JSON.stringify({ format: 'novel-project', schemaVersion: 1, id: 'x', title: 't', createdAt: 'a', updatedAt: 'b' }))
    expect(await openProject('/books/novel')).toBe(false)
    expect(dialog.messages[0].text).toMatch(/manuscript\.json is missing/)

    fs.dirs.add('/books/other')
    expect(await openProject('/books/other')).toBe(false)
    expect(dialog.messages[1].text).toMatch(/not a Novel project/)
  })

  it('flags a recent project whose folder is gone', async () => {
    await createProjectAt('/books/novel')
    fs.dirs.delete('/books/novel')
    fs.files.delete('/books/novel/project.json')
    const recent = await loadRecentProjects()
    expect(recent[0].missing).toBe(true)
    expect(recentFile.menu).toEqual([expect.objectContaining({ missing: true })])
    expect(await openProject('/books/novel')).toBe(false)
    expect(dialog.messages[0].text).toMatch(/could not be found/)
  })

  it('refuses to create a project over an existing one', async () => {
    await createProjectAt('/books/novel')
    await expect(createProjectAt('/books/novel')).rejects.toMatchObject({ code: 'already-exists' })
  })

  it('still opens and saves when index.sqlite is unavailable', async () => {
    sql.failLoad = true
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await createProjectAt('/books/novel')
    editor.update(textDoc('x'))
    expect(await saveProject()).toBe(true)
    warn.mockRestore()
  })

  it('marks the save failed and shows a dialog when writing fails', async () => {
    await createProjectAt('/books/novel')
    fs.dirs.delete('/books/novel')
    editor.update(textDoc('x'))
    expect(await saveProject()).toBe(false)
    expect(useStore.getState().project.saveStatus).toBe('error')
    expect(editor.isDirty()).toBe(true)
    expect(dialog.messages).toHaveLength(1)

    expect(await saveProject({ kind: 'autosave', silent: true })).toBe(false)
    expect(dialog.messages).toHaveLength(1)
  })

  it('coalesces concurrent saves', async () => {
    await createProjectAt('/books/novel')
    editor.update(textDoc('x'))
    fs.writes.length = 0
    const [a, b] = await Promise.all([saveProject(), saveProject()])
    expect(a && b).toBe(true)
    expect(fs.writes.filter((p) => p.endsWith('manuscript.json'))).toHaveLength(1)
  })

  it('Save with no project open asks for a folder and keeps the text', async () => {
    editor.update(textDoc('draft'))
    dialog.pick = '/books/novel'
    expect(await saveProject()).toBe(true)
    expect(JSON.parse(fs.files.get('/books/novel/manuscript.json')!)).toEqual(textDoc('draft'))
    expect(editor.getDocJSON()).toEqual(textDoc('draft'))
  })

  describe('unsaved-changes prompt', () => {
    beforeEach(async () => {
      await createProjectAt('/books/novel')
      editor.update(textDoc('unsaved'))
    })

    it('proceeds without asking when clean', async () => {
      editor.markClean()
      expect(await confirmUnsavedChanges('closing')).toBe(true)
      expect(dialog.messages).toEqual([])
    })

    it('Save saves, then proceeds', async () => {
      dialog.answer = 'Save'
      expect(await confirmUnsavedChanges('closing')).toBe(true)
      expect(dialog.messages[0].text).toMatch(/"novel" has unsaved changes/)
      expect(JSON.parse(fs.files.get('/books/novel/manuscript.json')!)).toEqual(textDoc('unsaved'))
    })

    it("Don't Save proceeds without saving", async () => {
      dialog.answer = "Don't Save"
      expect(await confirmUnsavedChanges('closing')).toBe(true)
      expect(JSON.parse(fs.files.get('/books/novel/manuscript.json')!)).not.toEqual(textDoc('unsaved'))
    })

    it('Cancel stops', async () => {
      dialog.answer = 'Cancel'
      expect(await confirmUnsavedChanges('closing')).toBe(false)
      dialog.pick = '/elsewhere'
      expect(await openProject()).toBe(false)
      expect(getCurrentProjectPath()).toBe('/books/novel')
    })
  })
})
