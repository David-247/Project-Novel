import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { useStore } from '@/shared/store'
import {
  getDocJSON,
  getEditor,
  isDirty,
  markClean,
  NovelEditor,
  onDocChange,
  setDocJSON,
  SYSTEM_FONT_STACK,
} from './index'
import { installLayoutPolyfills } from './jsdom-polyfills.test-util'

beforeAll(installLayoutPolyfills)
afterEach(() => {
  cleanup()
  setDocJSON({ type: 'doc', content: [{ type: 'paragraph' }] })
})

function mount() {
  render(<NovelEditor />)
  const ed = getEditor()
  if (!ed) throw new Error('editor not mounted')
  return ed
}

const story = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Chapter One' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'It was a dark night.' }] },
  ],
}

describe('NovelEditor', () => {
  it('mounts an editable manuscript in the OS system font by default', () => {
    mount()
    expect(screen.getByRole('textbox', { name: 'Manuscript' })).toHaveAttribute('contenteditable', 'true')
    expect(screen.getByTestId('writing-surface').style.fontFamily).toBe(SYSTEM_FONT_STACK)
    expect(SYSTEM_FONT_STACK).toMatch(/^system-ui, -apple-system, "Segoe UI"/)
  })

  it('defines the Phase 1 base schema', () => {
    const ed = mount()
    const nodes = Object.keys(ed.schema.nodes)
    for (const n of ['doc', 'paragraph', 'heading', 'text', 'hardBreak', 'bulletList', 'orderedList', 'listItem']) {
      expect(nodes).toContain(n)
    }
    const marks = Object.keys(ed.schema.marks)
    for (const m of ['bold', 'italic', 'underline', 'textStyle']) expect(marks).toContain(m)
    expect(ed.extensionManager.extensions.find((e) => e.name === 'heading')?.options.levels).toEqual([1, 2, 3])
  })

  it('handles the empty doc and tracks edits in the store without the doc JSON', () => {
    const ed = mount()
    expect(useStore.getState().editor.isEmpty).toBe(true)
    expect(getDocJSON()).toEqual({ type: 'doc', content: [{ type: 'paragraph' }] })
    const cb = vi.fn()
    const off = onDocChange(cb)
    const before = useStore.getState().editor.docVersion

    act(() => {
      ed.commands.insertContent('Hello')
    })
    const s = useStore.getState().editor
    expect(s).toEqual({ isEmpty: false, docVersion: before + 1, dirty: true })
    expect(isDirty()).toBe(true)
    expect(cb).toHaveBeenCalledTimes(1)

    markClean()
    expect(isDirty()).toBe(false)
    off()
    act(() => {
      ed.commands.insertContent('!')
    })
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('setDocJSON loads content, resets history, clears dirty, and does not fire onDocChange', () => {
    const ed = mount()
    act(() => {
      ed.commands.insertContent('typed before load')
    })
    expect(isDirty()).toBe(true)
    const cb = vi.fn()
    const off = onDocChange(cb)

    act(() => setDocJSON(story))
    expect(getDocJSON()).toEqual(story)
    expect(isDirty()).toBe(false)
    expect(useStore.getState().editor.isEmpty).toBe(false)
    expect(cb).not.toHaveBeenCalled()
    expect(getEditor()!.can().undo()).toBe(false)
    off()
  })

  it('setDocJSON before mount is applied when the editor mounts', () => {
    expect(getEditor()).toBeNull()
    setDocJSON(story)
    expect(getDocJSON()).toEqual(story)
    mount()
    expect(getDocJSON()).toEqual(story)
    expect(isDirty()).toBe(false)
  })

  it('supports bold/italic/underline and lists', () => {
    const ed = mount()
    act(() => {
      ed.chain().insertContent('word').selectAll().toggleBold().toggleItalic().toggleUnderline().run()
      ed.chain().toggleBulletList().run()
    })
    const json = JSON.stringify(getDocJSON())
    expect(json).toContain('"bulletList"')
    for (const m of ['bold', 'italic', 'underline']) expect(json).toContain(`"type":"${m}"`)
  })

  it('pastes 100k words of plain text and stays responsive', () => {
    const ed = mount()
    const para = Array.from({ length: 100 }, (_, i) => `word${i}`).join(' ')
    const text = Array.from({ length: 1000 }, () => para).join('\n\n') // 100,000 words, 1,000 paragraphs

    const t0 = performance.now()
    act(() => {
      ed.view.pasteText(text, new Event('paste') as ClipboardEvent)
    })
    const pasteMs = performance.now() - t0

    const words = ed.state.doc.textBetween(0, ed.state.doc.content.size, ' ').split(/\s+/).filter(Boolean)
    expect(words.length).toBe(100_000)
    expect(isDirty()).toBe(true)

    // Typing after the paste: a single keystroke-sized transaction.
    const t1 = performance.now()
    act(() => {
      ed.commands.insertContent('x')
    })
    const typeMs = performance.now() - t1

    console.info(`[perf] 100k-word paste: ${pasteMs.toFixed(0)} ms; next keystroke: ${typeMs.toFixed(1)} ms`)
    expect(pasteMs).toBeLessThan(15_000)
    expect(typeMs).toBeLessThan(200)
  }, 30_000)
})
