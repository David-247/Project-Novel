import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useStore } from '@/shared/store'

// The chapter list comes from the editor (getChapters reads the current style sheet). Here it is a
// stub whose answer the test changes, to check WHEN the model looks again.
const editorState = vi.hoisted(() => ({ titles: [] as string[], docListeners: new Set<() => void>() }))
vi.mock('@/features/editor', () => ({
  getEditor: () => ({ state: { doc: {} } }),
  getChapters: () => editorState.titles.map((title, index) => ({ index, title, from: index * 10, to: index * 10 + 10 })),
  onDocChange: (cb: () => void) => {
    editorState.docListeners.add(cb)
    return () => editorState.docListeners.delete(cb)
  },
}))

import { getTitlesVersion, trackChapterTitles } from './model'

let stop = () => {}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] })
  useStore.getState().bookActions.resetBook()
  useStore.getState().bookActions.setHeaderFooter((h) => ({ ...h, recto: { kind: 'chapter', text: '' } }))
  editorState.titles = ['One']
  stop = trackChapterTitles()
  vi.advanceTimersToNextFrame()
})
afterEach(() => {
  stop()
  vi.useRealTimers()
})

describe('chapter titles in running heads', () => {
  it('REGRESSION: a style change that makes blocks chapters (no document change) refreshes the titles', () => {
    const v = getTitlesVersion()
    // A "Duplicate of Chapter Title" now opens a chapter: same document, new chapter list.
    editorState.titles = ['One', 'Two']
    useStore.getState().bookActions.setStyles((s) => ({ ...s, 'custom-1': { name: 'Chapter Title copy', kind: 'chapter', basedOn: 'chapter-title', builtIn: false } }))
    vi.advanceTimersToNextFrame()
    expect(getTitlesVersion()).toBe(v + 1)
  })

  it('a document edit is still followed, and nothing happens while no head shows chapter titles', () => {
    const v = getTitlesVersion()
    editorState.titles = ['One!']
    editorState.docListeners.forEach((l) => l())
    vi.advanceTimersToNextFrame()
    expect(getTitlesVersion()).toBe(v + 1)

    useStore.getState().bookActions.setHeaderFooter((h) => ({ ...h, recto: { kind: 'title', text: '' } }))
    vi.advanceTimersToNextFrame()
    editorState.titles = ['Changed']
    useStore.getState().bookActions.setStyles((s) => ({ ...s, body: { fontSize: 12 } }))
    vi.advanceTimersToNextFrame()
    expect(getTitlesVersion()).toBe(v + 1)
  })
})
