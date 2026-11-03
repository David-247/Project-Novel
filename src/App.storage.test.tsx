import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { getEditor, NovelEditor, setDocJSON } from '@/features/editor'
import { openProject, saveProject, SaveStatusIndicator } from '@/features/storage'
import { registerDocumentProvider } from '@/shared/document'
import { useStore } from '@/shared/store'
import { backend } from '@/test-utils/fake-tauri'
import { editorDocumentProvider } from './App'

vi.mock('@tauri-apps/api/core', async () => (await import('@/test-utils/fake-tauri')).coreModule)
vi.mock('@tauri-apps/plugin-dialog', async () => (await import('@/test-utils/fake-tauri')).dialogModule)
vi.mock('@tauri-apps/plugin-sql', async () => (await import('@/test-utils/fake-tauri')).sqlModule)

// jsdom lacks layout APIs ProseMirror touches when scrolling the selection into view.
beforeAll(() => {
  const rect = { x: 0, y: 0, top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0, toJSON: () => ({}) }
  const emptyRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList
  Range.prototype.getClientRects ??= emptyRects
  Range.prototype.getBoundingClientRect ??= () => rect as DOMRect
  Element.prototype.getClientRects ??= emptyRects
  document.elementFromPoint ??= () => null
})

const manuscript = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Chapter One' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'It was a dark night.' }] },
  ],
}

let unregister = () => {}

beforeEach(() => {
  backend.reset()
  backend.dirs.add('/books/novel')
  backend.files.set(
    '/books/novel/project.json',
    JSON.stringify({ format: 'novel-project', schemaVersion: 1, id: 'id', title: 'My Novel', createdAt: 'a', updatedAt: 'b' }),
  )
  backend.files.set('/books/novel/manuscript.json', JSON.stringify(manuscript))
  backend.recent = [{ path: '/books/novel', name: 'My Novel', openedAt: 'a' }]
  unregister = registerDocumentProvider(editorDocumentProvider)
})

afterEach(() => {
  unregister()
  cleanup()
  setDocJSON({ type: 'doc', content: [{ type: 'paragraph' }] })
})

describe('storage + real editor (composition root adapter)', () => {
  it('open project -> content appears in the editor -> type -> save writes the typed text', async () => {
    render(
      <>
        <NovelEditor />
        <SaveStatusIndicator />
      </>,
    )
    expect(await openProject('/books/novel')).toBe(true)
    const textbox = screen.getByRole('textbox', { name: 'Manuscript' })
    expect(textbox).toHaveTextContent('Chapter One')
    expect(textbox).toHaveTextContent('It was a dark night.')
    expect(useStore.getState().editor.dirty).toBe(false)

    const ed = getEditor()!
    act(() => {
      ed.commands.focus('end')
      ed.commands.insertContent(' The rain fell.')
    })
    expect(useStore.getState().editor.dirty).toBe(true)
    expect(screen.getByRole('status')).toHaveTextContent('My Novel: Unsaved changes')

    let ok = false
    await act(async () => {
      ok = await saveProject()
    })
    expect(ok).toBe(true)
    const saved = JSON.parse(backend.files.get('/books/novel/manuscript.json')!)
    expect(JSON.stringify(saved)).toContain('It was a dark night. The rain fell.')
    expect(saved.content[0]).toMatchObject(manuscript.content[0])
    expect(useStore.getState().editor.dirty).toBe(false)
    expect(screen.getByRole('status')).toHaveTextContent('My Novel: Saved')
    expect(backend.messages).toEqual([])
  })

  it('a schema-invalid manuscript shows the corrupt-file dialog and leaves the editor untouched', async () => {
    render(<NovelEditor />)
    backend.files.set(
      '/books/novel/manuscript.json',
      JSON.stringify({ type: 'doc', content: [{ type: 'chart', content: [] }] }),
    )
    act(() => {
      getEditor()!.commands.insertContent('keep me')
    })
    backend.answer = "Don't Save"
    expect(await openProject('/books/novel')).toBe(false)
    expect(backend.messages.at(-1)!.text).toMatch(/manuscript\.json is damaged/)
    expect(screen.getByRole('textbox', { name: 'Manuscript' })).toHaveTextContent('keep me')
  })
})
