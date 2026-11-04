import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryDocumentProvider, registerDocumentProvider, type DocJSON } from '@/shared/document'
import { useStore } from '@/shared/store'
import { initialProjectState } from '@/shared/store/project-slice'
import { backend } from '@/test-utils/fake-tauri'

vi.mock('@tauri-apps/api/core', async () => (await import('@/test-utils/fake-tauri')).coreModule)
vi.mock('@tauri-apps/plugin-dialog', async () => (await import('@/test-utils/fake-tauri')).dialogModule)
vi.mock('@tauri-apps/plugin-sql', async () => (await import('@/test-utils/fake-tauri')).sqlModule)

import {
  closeProject,
  confirmUnsavedChanges,
  getCurrentProjectPath,
  loadRecentProjects,
  newProject,
  onProjectOpened,
  openProject,
  saveProject,
  updateProjectDetails,
} from './index'
import { __resetStorageForTests } from './project'

const textDoc = (text: string): DocJSON => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
})
const json = (path: string) => JSON.parse(backend.files.get(path)!)

let editor = createMemoryDocumentProvider()
let unregister = () => {}

async function freshSession() {
  await __resetStorageForTests()
  useStore.setState({ project: initialProjectState })
  unregister()
  editor = createMemoryDocumentProvider()
  unregister = registerDocumentProvider(editor)
  backend.active = backend.previous = null
  backend.messages.length = 0
}

/** New Project via the (Rust) folder dialog. */
async function createAt(folder: string) {
  backend.dirs.add(folder)
  backend.pick = folder
  expect(await newProject()).toBe(true)
}

beforeEach(async () => {
  backend.reset()
  await freshSession()
})

afterEach(() => unregister())

describe('project storage', () => {
  it('every open path shows "Opening…" while it runs and clears it after (New, Save As, Open, Open Recent, failure)', async () => {
    const seen: boolean[] = []
    const unsubscribe = useStore.subscribe((s, p) => {
      if (s.project.opening !== p.project.opening) seen.push(s.project.opening)
    })
    const expectOpeningCycle = () => {
      expect(seen).toEqual([true, false])
      seen.length = 0
    }
    await createAt('/books/a') // New Project
    expectOpeningCycle()
    await closeProject()
    editor.update(textDoc('draft'))
    backend.dirs.add('/books/b')
    backend.pick = '/books/b'
    expect(await saveProject()).toBe(true) // Save As (no project open)
    expectOpeningCycle()
    backend.pick = '/books/a'
    expect(await openProject()).toBe(true) // Open Project
    expectOpeningCycle()
    await loadRecentProjects()
    expect(await openProject('/books/b')).toBe(true) // Open Recent / Reopen after a crash
    expectOpeningCycle()
    backend.dirs.add('/books/empty')
    backend.pick = '/books/empty'
    expect(await openProject()).toBe(false) // not a project: still cleared
    expectOpeningCycle()
    unsubscribe()
  })

  it('creates, saves, reopens from recent with identical content', async () => {
    const opened = vi.fn()
    onProjectOpened(opened)
    await createAt('/books/novel')

    expect(json('/books/novel/project.json')).toMatchObject({ format: 'novel-project', schemaVersion: 1, title: 'novel' })
    expect(backend.sqlLoads).toEqual(['sqlite:/books/novel/index.sqlite'])
    expect(backend.sqlExecuted.some((q) => q.includes('CREATE TABLE IF NOT EXISTS revisions'))).toBe(true)
    expect(opened).toHaveBeenCalledWith(expect.objectContaining({ path: '/books/novel' }))
    expect(getCurrentProjectPath()).toBe('/books/novel')
    expect(backend.recent.map((r) => r.path)).toEqual(['/books/novel'])

    const content = textDoc('It was a dark and stormy night.')
    editor.update(content)
    expect(await saveProject()).toBe(true)
    expect(editor.isDirty()).toBe(false)
    expect(useStore.getState().project.saveStatus).toBe('saved')
    expect(json('/books/novel/manuscript.json')).toEqual(content)
    expect(backend.sqlExecuted.some((q) => /insert into "revisions"/i.test(q))).toBe(true)

    // "Quit": drop all in-memory state (incl. Rust's granted root), keep disk + recent file.
    await freshSession()
    const recent = await loadRecentProjects()
    expect(recent.map((r) => r.path)).toEqual(['/books/novel'])
    expect(backend.menu).toEqual([{ path: '/books/novel', label: 'novel (/books/novel)', missing: false }])

    expect(await openProject(recent[0].path)).toBe(true)
    expect(editor.getDocJSON()).toEqual(content)
    expect(editor.isDirty()).toBe(false)
    expect(backend.messages).toEqual([])
  })

  it('shows an error dialog for a corrupted manuscript.json instead of crashing', async () => {
    await createAt('/books/novel')
    backend.files.set('/books/novel/manuscript.json', '{"type":"doc","content":[{"type":"parag')
    await freshSession()

    expect(await openProject('/books/novel')).toBe(false)
    expect(backend.messages).toHaveLength(1)
    expect(backend.messages[0].text).toMatch(/manuscript\.json is damaged/)
    expect(backend.messages[0].opts).toMatchObject({ kind: 'error', title: 'Could not open project' })
    expect(getCurrentProjectPath()).toBeNull()
    expect(backend.active).toBeNull() // grant undone
  })

  it('reports a doc the editor rejects as a damaged manuscript', async () => {
    await createAt('/books/novel')
    await freshSession()
    editor.setDocJSON = () => {
      throw new RangeError('Unknown node type: chart')
    }
    expect(await openProject('/books/novel')).toBe(false)
    expect(backend.messages[0].text).toMatch(/content Novel cannot display/)
  })

  it('reports a missing manuscript.json and a non-project folder', async () => {
    await createAt('/books/novel')
    backend.files.delete('/books/novel/manuscript.json')
    await freshSession()
    expect(await openProject('/books/novel')).toBe(false)
    expect(backend.messages[0].text).toMatch(/manuscript\.json is missing/)

    backend.dirs.add('/books/other')
    backend.pick = '/books/other'
    expect(await openProject()).toBe(false)
    expect(backend.messages[1].text).toMatch(/not a Novel project/)
  })

  it('Open Recent only accepts folders in the Rust-written recent list', async () => {
    backend.dirs.add('/etc')
    expect(await openProject('/etc')).toBe(false)
    expect(backend.active).toBeNull()
    expect(backend.messages[0].text).toMatch(/could not be accessed/)
  })

  it('flags a recent project whose folder is gone', async () => {
    await createAt('/books/novel')
    backend.dirs.delete('/books/novel')
    backend.files.delete('/books/novel/project.json')
    await freshSession()
    const recent = await loadRecentProjects()
    expect(recent[0].missing).toBe(true)
    expect(backend.menu).toEqual([expect.objectContaining({ missing: true })])
    expect(await openProject('/books/novel')).toBe(false)
    expect(backend.messages[0].text).toMatch(/could not be found/)
  })

  it('a failed open keeps the previous project saveable; close clears the root', async () => {
    await createAt('/books/novel')
    backend.dirs.add('/books/broken')
    backend.files.set('/books/broken/project.json', '{oops')
    backend.pick = '/books/broken'
    expect(await openProject()).toBe(false)
    expect(backend.active).toBe('/books/novel')
    editor.update(textDoc('still saves'))
    expect(await saveProject()).toBe(true)
    expect(json('/books/novel/manuscript.json')).toEqual(textDoc('still saves'))
    await closeProject()
    expect(backend.active).toBeNull()
  })

  it('refuses to create a project over an existing one', async () => {
    await createAt('/books/novel')
    backend.pick = '/books/novel'
    expect(await newProject()).toBe(false)
    expect(backend.messages[0].text).toMatch(/already contains a Novel project/)
  })

  it('reopening the already-open project keeps a live index (revisions still recorded)', async () => {
    await createAt('/books/novel')
    backend.pick = '/books/novel'
    expect(await openProject()).toBe(true) // same folder, same sqlite URL
    expect(backend.sqlPools.get('sqlite:/books/novel/index.sqlite')?.closed).toBe(false)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const before = backend.sqlExecuted.filter((q) => /insert into "revisions"/i.test(q)).length
    editor.update(textDoc('after reopen'))
    expect(await saveProject()).toBe(true)
    expect(backend.sqlExecuted.filter((q) => /insert into "revisions"/i.test(q))).toHaveLength(before + 1)
    expect(warn).not.toHaveBeenCalledWith('Recording revision failed:', expect.anything())
    warn.mockRestore()
  })

  it.each(['manuscript.json', 'index.sqlite'])(
    'New Project refuses a folder with a leftover %s (no project.json) and overwrites nothing',
    async (file) => {
      backend.dirs.add('/books/old')
      backend.files.set(`/books/old/${file}`, 'precious')
      backend.pick = '/books/old'
      expect(await newProject()).toBe(false)
      expect(backend.messages[0].text).toMatch(new RegExp(`already contains ${file.replace('.', '\\.')}`))
      expect(backend.files.get(`/books/old/${file}`)).toBe('precious')
      expect(backend.writes).toEqual([])
      expect(backend.active).toBeNull()
    },
  )

  it('ignores a second New/Open while one is still in its dialogs', async () => {
    await createAt('/books/novel')
    editor.update(textDoc('dirty'))
    let answer!: (v: string) => void
    const { dialogModule } = await import('@/test-utils/fake-tauri')
    const original = dialogModule.message
    // Hold the unsaved-changes prompt of the first flow open.
    dialogModule.message = (text, opts) => {
      backend.messages.push({ text, opts })
      return new Promise<string>((r) => (answer = r))
    }
    const first = openProject()
    await vi.waitFor(() => expect(backend.messages).toHaveLength(1))
    expect(await newProject()).toBe(false) // overlapping flow ignored, no second prompt
    expect(await openProject()).toBe(false)
    expect(backend.messages).toHaveLength(1)
    answer('Cancel')
    expect(await first).toBe(false)
    dialogModule.message = original
    backend.pick = '/books/novel'
    editor.markClean()
    expect(await openProject()).toBe(true) // guard released
  })

  it('still opens and saves when index.sqlite is unavailable', async () => {
    backend.failSqlLoad = true
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await createAt('/books/novel')
    editor.update(textDoc('x'))
    expect(await saveProject()).toBe(true)
    warn.mockRestore()
  })

  it('marks the save failed and shows a dialog when writing fails', async () => {
    await createAt('/books/novel')
    backend.dirs.delete('/books/novel')
    editor.update(textDoc('x'))
    expect(await saveProject()).toBe(false)
    expect(useStore.getState().project.saveStatus).toBe('error')
    expect(editor.isDirty()).toBe(true)
    expect(backend.messages).toHaveLength(1)

    expect(await saveProject({ kind: 'autosave', silent: true })).toBe(false)
    expect(backend.messages).toHaveLength(1)
  })

  it('coalesces concurrent saves', async () => {
    await createAt('/books/novel')
    editor.update(textDoc('x'))
    backend.writes.length = 0
    const [a, b] = await Promise.all([saveProject(), saveProject()])
    expect(a && b).toBe(true)
    expect(backend.writes.filter((p) => p.endsWith('manuscript.json'))).toHaveLength(1)
  })

  it('keeps the doc dirty if it changed while saving (version-guarded markClean)', async () => {
    await createAt('/books/novel')
    editor.update(textDoc('first'))
    const saving = saveProject()
    editor.update(textDoc('typed during save'))
    expect(await saving).toBe(true)
    expect(json('/books/novel/manuscript.json')).toEqual(textDoc('first'))
    expect(editor.isDirty()).toBe(true)
  })

  it('Save with no project open asks for a folder and keeps the text', async () => {
    editor.update(textDoc('draft'))
    backend.dirs.add('/books/novel')
    backend.pick = '/books/novel'
    expect(await saveProject()).toBe(true)
    expect(json('/books/novel/manuscript.json')).toEqual(textDoc('draft'))
    expect(editor.getDocJSON()).toEqual(textDoc('draft'))
    expect(editor.isDirty()).toBe(false)
  })

  it('reports a missing editor instead of crashing', async () => {
    unregister()
    backend.pick = '/books/novel'
    expect(await newProject()).toBe(false)
    expect(backend.messages[0].text).toMatch(/editor is not ready/)
  })

  describe('unsaved-changes prompt', () => {
    beforeEach(async () => {
      await createAt('/books/novel')
      editor.update(textDoc('unsaved'))
    })

    it('proceeds without asking when clean', async () => {
      editor.markClean()
      expect(await confirmUnsavedChanges('closing')).toBe(true)
      expect(backend.messages).toEqual([])
    })

    it('Save saves, then proceeds', async () => {
      backend.answer = 'Save'
      expect(await confirmUnsavedChanges('closing')).toBe(true)
      expect(backend.messages[0].text).toMatch(/"novel" has unsaved changes/)
      expect(json('/books/novel/manuscript.json')).toEqual(textDoc('unsaved'))
    })

    it("Don't Save proceeds without saving", async () => {
      backend.answer = "Don't Save"
      expect(await confirmUnsavedChanges('closing')).toBe(true)
      expect(json('/books/novel/manuscript.json')).not.toEqual(textDoc('unsaved'))
    })

    it('falls back to window.confirm when the dialog plugin fails, instead of blocking', async () => {
      backend.failDialog = true
      const err = vi.spyOn(console, 'error').mockImplementation(() => {})
      const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(true).mockReturnValueOnce(false)
      expect(await confirmUnsavedChanges('closing')).toBe(true)
      expect(await confirmUnsavedChanges('closing')).toBe(false)
      expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/unsaved changes/))
      confirm.mockImplementation(() => {
        throw new Error('no confirm here')
      })
      expect(await confirmUnsavedChanges('closing')).toBe(true) // never trap the user
      confirm.mockRestore()
      err.mockRestore()
    })

    it('Cancel stops', async () => {
      backend.answer = 'Cancel'
      expect(await confirmUnsavedChanges('closing')).toBe(false)
      backend.pick = '/elsewhere'
      expect(await openProject()).toBe(false)
      expect(getCurrentProjectPath()).toBe('/books/novel')
    })
  })
})

describe('book details (title and author)', () => {
  it('writes project.json at once, updates the store, keeps the id, and survives the next save and a reopen', async () => {
    await createAt('/books/novel')
    expect(useStore.getState().project.author).toBe('')
    const id = json('/books/novel/project.json').id
    expect(await updateProjectDetails({ title: '  The Long Road ', author: ' Ada Quill ' })).toBe(true)
    expect(json('/books/novel/project.json')).toMatchObject({ id, title: 'The Long Road', author: 'Ada Quill' })
    expect(useStore.getState().project).toMatchObject({ title: 'The Long Road', author: 'Ada Quill' })
    expect(backend.recent[0].name).toBe('The Long Road')
    // A later save keeps the new details (it rewrites project.json from the latest metadata).
    editor.update(textDoc('words'))
    expect(await saveProject()).toBe(true)
    expect(json('/books/novel/project.json')).toMatchObject({ title: 'The Long Road', author: 'Ada Quill' })
    await closeProject()
    backend.pick = '/books/novel'
    expect(await openProject()).toBe(true)
    expect(useStore.getState().project).toMatchObject({ title: 'The Long Road', author: 'Ada Quill' })
  })

  it('a blank title keeps the old one; an unchanged call writes nothing; no project open is a no-op', async () => {
    expect(await updateProjectDetails({ title: 'x' })).toBe(false)
    await createAt('/books/novel')
    expect(await updateProjectDetails({ title: '   ', author: 'A' })).toBe(true)
    expect(json('/books/novel/project.json')).toMatchObject({ title: 'novel', author: 'A' })
    const before = backend.files.get('/books/novel/project.json')
    expect(await updateProjectDetails({ author: 'A' })).toBe(true)
    expect(backend.files.get('/books/novel/project.json')).toBe(before)
  })

  it('a project.json without author opens with an empty author', async () => {
    await createAt('/books/old')
    const meta = json('/books/old/project.json')
    delete meta.author
    backend.files.set('/books/old/project.json', JSON.stringify(meta))
    await closeProject()
    backend.pick = '/books/old'
    expect(await openProject()).toBe(true)
    expect(useStore.getState().project.author).toBe('')
  })
})
