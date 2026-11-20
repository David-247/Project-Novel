import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryDocumentProvider, registerDocumentProvider } from '@/shared/document'
import { useStore } from '@/shared/store'
import { backend } from '@/test-utils/fake-tauri'

vi.mock('@tauri-apps/api/core', async () => (await import('@/test-utils/fake-tauri')).coreModule)
vi.mock('@tauri-apps/plugin-dialog', async () => (await import('@/test-utils/fake-tauri')).dialogModule)
vi.mock('@tauri-apps/plugin-sql', async () => (await import('@/test-utils/fake-tauri')).sqlModule)

import { loadRecentProjects, newProject, openProject, saveProject } from '@/features/storage'
import { addWord, dictionaryWords } from './index'
import { __resetDictionaryFileForTests, dictionarySideFile, registerDictionarySideFile } from './persistence'

const ROOT = '/books/novel'
const FILE = `${ROOT}/dictionary.json`

let editor = createMemoryDocumentProvider()
let unregisterEditor = () => {}
let unregisterSide = () => {}

const userWords = () => useStore.getState().preferences.spellcheck.words
const projectWords = () => useStore.getState().spellcheck.projectWords

beforeEach(() => {
  vi.useFakeTimers()
  backend.reset()
  useStore.getState().preferencesActions.set('spellcheck', { words: [] })
  useStore.getState().spellcheckActions.loadProjectWords([])
  __resetDictionaryFileForTests()
  editor = createMemoryDocumentProvider()
  unregisterEditor = registerDocumentProvider(editor)
  unregisterSide = registerDictionarySideFile()
})

afterEach(() => {
  unregisterSide()
  unregisterEditor()
  vi.useRealTimers()
})

async function createProject() {
  backend.dirs.add(ROOT)
  backend.pick = ROOT
  expect(await newProject()).toBe(true)
}

describe('dictionary.json (project words)', () => {
  it('round-trips project words through the storage side file', async () => {
    await createProject()
    expect(backend.files.has(FILE)).toBe(false) // an empty dictionary creates no file
    expect(addWord('Aelinor', 'project')).toBe(true)
    expect(await saveProject()).toBe(true)
    expect(JSON.parse(backend.files.get(FILE)!)).toEqual({ version: 1, words: ['Aelinor'] })

    useStore.getState().spellcheckActions.loadProjectWords([]) // as if another project was open
    await loadRecentProjects()
    expect(await openProject(ROOT)).toBe(true)
    expect(projectWords()).toEqual(['Aelinor'])
    expect(dictionaryWords()).toEqual(['Aelinor'])
  })

  it('a project word is a project change; a user word is not (it lives in preferences)', async () => {
    await createProject()
    expect(await saveProject()).toBe(true)
    expect(editor.isDirty()).toBe(false)
    addWord('Zoë', 'user')
    expect(editor.isDirty()).toBe(false)
    expect(userWords()).toEqual(['Zoë'])
    expect(backend.files.has(FILE)).toBe(false)
    addWord('Aelinor', 'project')
    expect(editor.isDirty()).toBe(true)
  })

  it('keeps unknown keys, drops unreadable words, and flags a newer file', () => {
    const result = dictionarySideFile.load({ version: 2, words: ['Aelinor', 7, 'two words', 'aelinor', ' Brynn '], note: { a: 1 } })
    expect(result).toEqual({ newer: 2 })
    expect(projectWords()).toEqual(['Aelinor', 'Brynn'])
    expect(dictionarySideFile.serialize().data).toEqual({ note: { a: 1 }, version: 1, words: ['Aelinor', 'Brynn'] })
  })

  it('loading is not a change, and a missing file loads empty', () => {
    const before = dictionarySideFile.getVersion()
    dictionarySideFile.load({ version: 1, words: ['Aelinor'] })
    expect(dictionarySideFile.getVersion()).toBe(before)
    dictionarySideFile.load(null)
    expect(projectWords()).toEqual([])
    expect(dictionarySideFile.serialize().empty).toBe(true)
  })
})
