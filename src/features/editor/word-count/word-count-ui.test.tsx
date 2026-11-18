import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { TextSelection } from '@tiptap/pm/state'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { getCommand, runCommand, __resetCommandsForTests } from '@/shared/commands'
import { useStore } from '@/shared/store'
import { TooltipProvider } from '@/shared/ui'
import { flushWordCount, getEditor, NovelEditor, registerEditorCommands, setDocJSON, setWordCountLineSource, WordCountDialog, WordCountIndicator, wordCountText } from '../index'
import { installLayoutPolyfills } from '../jsdom-polyfills.test-util'
import { WORD_COUNT_THROTTLE_MS } from './publisher'
import { closeWordCount } from './WordCount'

beforeAll(installLayoutPolyfills)
afterEach(() => {
  act(() => closeWordCount())
  act(() => useStore.getState().wordCountActions.setIncludeFootnotes(true))
  cleanup()
  __resetCommandsForTests()
  setDocJSON({ type: 'doc', content: [{ type: 'paragraph' }] })
  vi.useRealTimers()
})

const p = (t: string) => ({ type: 'paragraph', content: [{ type: 'text', text: t }] })
const withNote = (t: string, note: string) => ({ type: 'paragraph', content: [{ type: 'text', text: t }, { type: 'footnote', content: [{ type: 'text', text: note }] }] })

function mount(doc: unknown) {
  setDocJSON(doc as Parameters<typeof setDocJSON>[0])
  const off = registerEditorCommands()
  render(
    <TooltipProvider>
      <NovelEditor />
      <WordCountIndicator />
      <WordCountDialog />
    </TooltipProvider>,
  )
  act(() => flushWordCount())
  return { ed: getEditor()!, off }
}

describe('status bar text (Word style)', () => {
  it('"98,412 words", "1 word", "1,203 of 98,412 words"', () => {
    expect(wordCountText(98412, null)).toBe('98,412 words')
    expect(wordCountText(1, null)).toBe('1 word')
    expect(wordCountText(98412, 1203)).toBe('1,203 of 98,412 words')
  })
})

describe('live word count in the app', () => {
  it('shows the book count, then "n of m words" with a selection; no live region', () => {
    const { ed } = mount({ type: 'doc', content: [p('one two three'), p('four five')] })
    const count = screen.getByTestId('word-count')
    expect(count).toHaveTextContent('5 words')
    expect(count.closest('[aria-live]')).toBeNull()
    act(() => {
      ed.view.dispatch(ed.state.tr.setSelection(TextSelection.create(ed.state.doc, 1, 8)))
      flushWordCount()
    })
    expect(screen.getByTestId('word-count')).toHaveTextContent('2 of 5 words')
  })

  it('updates off the typing path: not in the keystroke, within the throttle after it', () => {
    vi.useFakeTimers()
    const { ed } = mount({ type: 'doc', content: [p('one two')] })
    act(() => {
      ed.view.dispatch(ed.state.tr.insertText(' three', ed.state.doc.content.size - 1))
    })
    expect(screen.getByTestId('word-count')).toHaveTextContent('2 words')
    act(() => vi.advanceTimersByTime(WORD_COUNT_THROTTLE_MS + 500))
    expect(screen.getByTestId('word-count')).toHaveTextContent('3 words')
  })

  it('publishes per chapter, the front matter and the footnotes apart in the store', () => {
    mount({ type: 'doc', content: [p('Front'), { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'One' }] }, withNote('a b', 'c d e')] })
    const w = useStore.getState().wordCount
    expect(w.ready).toBe(true)
    expect(w.document.body.words).toBe(4)
    expect(w.document.footnotes.words).toBe(3)
    expect(w.document.total.words).toBe(7)
    expect(w.frontMatter.total.words).toBe(1)
    expect(w.chapters.map((c) => [c.title, c.counts.total.words])).toEqual([['One', 6]])
  })
})

describe('Word Count dialog', () => {
  it('opens from the command (Review, Mod-Shift-g) and shows the statistics, footnotes included by default', () => {
    setWordCountLineSource(() => 7)
    mount({ type: 'doc', content: [withNote('A road home.', 'First told in 1902.')] })
    const cmd = getCommand('review.wordCount')!
    expect(cmd.shortcut).toBe('Mod-Shift-g')
    expect(cmd.menu?.id).toBe('review')
    act(() => runCommand('review.wordCount'))
    const dialog = screen.getByRole('dialog', { name: 'Word Count' })
    const stat = (label: string) => dialog.querySelector(`[data-stat="${label}"]`)!.textContent
    expect(stat('Words')).toBe('7')
    expect(stat('Characters (no spaces)')).toBe(String('Aroadhome.'.length + 'Firsttoldin1902.'.length))
    expect(stat('Characters (with spaces)')).toBe(String('A road home.'.length + 'First told in 1902.'.length))
    expect(stat('Paragraphs')).toBe('2')
    expect(stat('Lines')).toBe('7')
    expect(stat('Pages')).toBe('–')
    // Include footnotes off: the dialog and the status bar count the body only.
    fireEvent.click(screen.getByRole('checkbox', { name: 'Include footnotes' }))
    expect(stat('Words')).toBe('3')
    expect(screen.getByTestId('word-count')).toHaveTextContent('3 words')
    setWordCountLineSource(null)
  })

  it('counts the selection when there is one, and the status bar opens it', () => {
    const { ed } = mount({ type: 'doc', content: [p('alpha beta gamma delta')] })
    act(() => ed.view.dispatch(ed.state.tr.setSelection(TextSelection.create(ed.state.doc, 1, 11))))
    fireEvent.click(screen.getByRole('button', { name: /Word count$/ }))
    const dialog = screen.getByRole('dialog', { name: 'Word Count' })
    expect(dialog).toHaveTextContent('Counts of the selected text.')
    expect(dialog.querySelector('[data-stat="Words"]')!.textContent).toBe('2')
  })
})
