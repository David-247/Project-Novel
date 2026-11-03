import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { JSONContent } from '@tiptap/core'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { useStore } from '@/shared/store'
import { FindButton, FindReplacePanel, getEditor, HISTORY_DEPTH, HistoryButtons, NovelEditor, setDocJSON } from '../index'
import { installLayoutPolyfills } from '../jsdom-polyfills.test-util'
import { getMatches, HIGHLIGHT_WINDOW, replaceAll, scanNow } from './engine'
import { CURRENT_CLASS, MATCH_CLASS } from './plugin'
import { findMatches } from './search'

beforeAll(installLayoutPolyfills)

const INITIAL_FIND = useStore.getState().find

afterEach(() => {
  cleanup()
  useStore.setState({ find: { ...INITIAL_FIND } })
  setDocJSON({ type: 'doc', content: [{ type: 'paragraph' }] })
})

const para = (...content: JSONContent[]): JSONContent => ({ type: 'paragraph', content })
const t = (text: string, marks?: string[]): JSONContent => ({
  type: 'text',
  text,
  ...(marks ? { marks: marks.map((type) => ({ type })) } : {}),
})

function mountAll(doc?: JSONContent) {
  if (doc) setDocJSON(doc)
  render(
    <>
      <HistoryButtons />
      <FindButton />
      <FindReplacePanel />
      <NovelEditor />
    </>,
  )
  const ed = getEditor()
  if (!ed) throw new Error('editor not mounted')
  return ed
}

const story = {
  type: 'doc',
  content: [para(t('The cat sat. A cat')), para(t('ran; the c'), t('at', ['bold']), t(' hid.'))],
}

function key(target: Element, k: string, init: KeyboardEventInit = {}) {
  fireEvent.keyDown(target, { key: k, ...init })
}

const status = () => screen.getByTestId('find-status').textContent

describe('history', () => {
  it('is configured with effectively unlimited depth', () => {
    const ed = mountAll()
    expect(HISTORY_DEPTH).toBe(Number.MAX_SAFE_INTEGER)
    const ext = ed.extensionManager.extensions.find((e) => e.name === 'undoRedo')
    expect(ext?.options.depth).toBe(Number.MAX_SAFE_INTEGER)
  })

  it('Mod-z undoes; Mod-Shift-z and Mod-y redo; buttons follow availability', () => {
    const ed = mountAll()
    const undo = screen.getByRole('button', { name: 'Undo' })
    const redo = screen.getByRole('button', { name: 'Redo' })
    expect(undo).toBeDisabled()
    expect(redo).toBeDisabled()

    act(() => {
      ed.commands.insertContent('hello')
    })
    expect(undo).toBeEnabled()
    expect(redo).toBeDisabled()

    act(() => key(ed.view.dom, 'z', { ctrlKey: true }))
    expect(ed.state.doc.textContent).toBe('')
    expect(undo).toBeDisabled()
    expect(redo).toBeEnabled()

    act(() => key(ed.view.dom, 'z', { ctrlKey: true, shiftKey: true }))
    expect(ed.state.doc.textContent).toBe('hello')

    act(() => key(ed.view.dom, 'z', { ctrlKey: true }))
    expect(ed.state.doc.textContent).toBe('')
    act(() => key(ed.view.dom, 'y', { ctrlKey: true }))
    expect(ed.state.doc.textContent).toBe('hello')

    // Buttons do the same.
    fireEvent.click(undo)
    expect(ed.state.doc.textContent).toBe('')
    fireEvent.click(redo)
    expect(ed.state.doc.textContent).toBe('hello')
  })

  it('buttons reset when a document is loaded (history cleared)', () => {
    const ed = mountAll()
    act(() => {
      ed.commands.insertContent('typed')
    })
    expect(screen.getByRole('button', { name: 'Undo' })).toBeEnabled()
    act(() => setDocJSON(story))
    expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled()
  })
})

describe('find & replace panel', () => {
  it('Mod-f in the editor opens and focuses the panel; Escape closes it and refocuses the editor', async () => {
    const ed = mountAll(story)
    expect(screen.queryByRole('region', { name: 'Find and replace' })).toBeNull()

    act(() => key(ed.view.dom, 'f', { ctrlKey: true }))
    const input = screen.getByRole('textbox', { name: 'Find' })
    expect(document.activeElement).toBe(input)
    expect(screen.getByRole('button', { name: 'Find and replace' })).toHaveAttribute('aria-expanded', 'true')

    fireEvent.change(input, { target: { value: 'cat' } })
    await waitFor(() => expect(status()).toBe('1 of 3'))
    expect(ed.view.dom.querySelectorAll(`.${MATCH_CLASS}`).length).toBeGreaterThanOrEqual(3)
    expect(ed.view.dom.querySelectorAll(`.${CURRENT_CLASS}`).length).toBeGreaterThanOrEqual(1)

    act(() => key(input, 'Enter'))
    expect(status()).toBe('2 of 3')
    act(() => key(input, 'Enter'))
    expect(status()).toBe('3 of 3')
    // The third match spans plain "c" + bold "at".
    const { from, to } = ed.state.selection
    expect(ed.state.doc.textBetween(from, to)).toBe('cat')
    act(() => key(input, 'Enter'))
    expect(status()).toBe('1 of 3')
    act(() => key(input, 'Enter', { shiftKey: true }))
    expect(status()).toBe('3 of 3')

    act(() => key(input, 'Escape'))
    expect(screen.queryByRole('region', { name: 'Find and replace' })).toBeNull()
    expect(useStore.getState().find.open).toBe(false)
    expect(ed.view.dom.querySelectorAll(`.${MATCH_CLASS}`)).toHaveLength(0)
    await waitFor(() => expect(ed.view.hasFocus() || document.activeElement === ed.view.dom).toBe(true))
  })

  it('Mod-f works with focus outside the editor and pre-fills from the selection', () => {
    const ed = mountAll(story)
    act(() => {
      ed.commands.setTextSelection({ from: 5, to: 8 }) // "cat"
    })
    act(() => key(document.body, 'f', { ctrlKey: true }))
    const input = screen.getByRole('textbox', { name: 'Find' }) as HTMLInputElement
    expect(input.value).toBe('cat')
    expect(useStore.getState().find.query).toBe('cat')
  })

  it('applies case and whole-word options', async () => {
    const ed = mountAll({
      type: 'doc',
      content: [para(t('Cat cat category CAT'))],
    })
    act(() => key(ed.view.dom, 'f', { ctrlKey: true }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Find' }), { target: { value: 'cat' } })
    await waitFor(() => expect(useStore.getState().find.matchCount).toBe(4))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Whole word' }))
    await waitFor(() => expect(useStore.getState().find.matchCount).toBe(3))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Match case' }))
    await waitFor(() => expect(useStore.getState().find.matchCount).toBe(1))
    fireEvent.change(screen.getByRole('textbox', { name: 'Find' }), { target: { value: '' } })
    await waitFor(() => expect(useStore.getState().find.matchCount).toBe(0))
    expect(status()).toBe('')
    expect(screen.getByRole('button', { name: 'Next match' })).toBeDisabled()
  })

  it('shows "No results" and disables actions when nothing matches', async () => {
    const ed = mountAll(story)
    act(() => key(ed.view.dom, 'f', { ctrlKey: true }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Find' }), { target: { value: 'zebra' } })
    await waitFor(() => expect(status()).toBe('No results'))
    expect(screen.getByRole('button', { name: 'Replace all' })).toBeDisabled()
  })

  it('Replace replaces the current match (keeping marks) and moves on', async () => {
    const ed = mountAll(story)
    act(() => useStore.getState().findActions.openPanel('cat'))
    await waitFor(() => expect(status()).toBe('1 of 3'))
    fireEvent.change(screen.getByRole('textbox', { name: 'Replace with' }), { target: { value: 'dog' } })

    fireEvent.click(screen.getByRole('button', { name: 'Replace' }))
    expect(ed.state.doc.textContent).toBe('The dog sat. A catran; the cat hid.')
    expect(status()).toBe('1 of 2')
    act(() => key(screen.getByRole('textbox', { name: 'Replace with' }), 'Enter'))
    act(() => key(screen.getByRole('textbox', { name: 'Replace with' }), 'Enter'))
    expect(ed.state.doc.textContent).toBe('The dog sat. A dogran; the dog hid.')
    expect(status()).toBe('No results')
    // Last replacement started on plain "c", so it is plain.
    expect(ed.state.doc.child(1).textContent).toBe('ran; the dog hid.')
  })

  it('Replace all is a single transaction and a single undo restores everything', async () => {
    const ed = mountAll(story)
    const before = ed.getJSON()
    act(() => useStore.getState().findActions.openPanel('cat'))
    await waitFor(() => expect(status()).toBe('1 of 3'))
    fireEvent.change(screen.getByRole('textbox', { name: 'Replace with' }), { target: { value: 'lion' } })

    let transactions = 0
    const count = () => {
      transactions++
    }
    ed.on('update', count)
    fireEvent.click(screen.getByRole('button', { name: 'Replace all' }))
    ed.off('update', count)
    expect(transactions).toBe(1)
    expect(ed.state.doc.textContent).toBe('The lion sat. A lionran; the lion hid.')
    expect(status()).toBe('Replaced 3')

    act(() => key(ed.view.dom, 'z', { ctrlKey: true }))
    expect(ed.getJSON()).toEqual(before)
    act(() => key(ed.view.dom, 'y', { ctrlKey: true }))
    expect(ed.state.doc.textContent).toBe('The lion sat. A lionran; the lion hid.')
  })

  it('does not scan or highlight while the panel is closed', async () => {
    const ed = mountAll(story)
    act(() => useStore.getState().findActions.openPanel('cat'))
    await waitFor(() => expect(getMatches()).toHaveLength(3))
    fireEvent.click(screen.getByRole('button', { name: 'Close find and replace' }))
    expect(getMatches()).toHaveLength(0)
    act(() => {
      ed.commands.insertContent(' cat cat')
    })
    await new Promise((r) => setTimeout(r, 400))
    expect(getMatches()).toHaveLength(0)
    expect(ed.view.dom.querySelectorAll(`.${MATCH_CLASS}`)).toHaveLength(0)
  })

  it('re-scans (debounced) after document edits while open', async () => {
    const ed = mountAll(story)
    act(() => useStore.getState().findActions.openPanel('cat'))
    await waitFor(() => expect(useStore.getState().find.matchCount).toBe(3))
    act(() => {
      ed.commands.setTextSelection(ed.state.doc.content.size - 1)
      ed.commands.insertContent(' cat')
    })
    // Not synchronous: the count updates after the debounce.
    expect(useStore.getState().find.matchCount).toBe(3)
    await waitFor(() => expect(useStore.getState().find.matchCount).toBe(4))
  })

  it('every control has a stable data-control-id and an accessible name', () => {
    mountAll(story)
    act(() => useStore.getState().findActions.openPanel('cat'))
    const ids = Array.from(document.querySelectorAll('[data-control-id]')).map((el) => el.getAttribute('data-control-id'))
    expect(ids.sort()).toEqual(
      [
        'find.caseSensitive',
        'find.close',
        'find.next',
        'find.open',
        'find.previous',
        'find.query',
        'find.replace',
        'find.replaceAll',
        'find.replacement',
        'find.wholeWord',
        'history.redo',
        'history.undo',
      ].sort(),
    )
    for (const el of document.querySelectorAll<HTMLElement>('[data-control-id]')) {
      expect(el.getAttribute('aria-label'), el.getAttribute('data-control-id')!).toBeTruthy()
    }
  })
})

describe('performance at 100k words', () => {
  it('find all and replace all stay fast', () => {
    const vocab = ['the', 'river', 'quietly', 'carried', 'lantern', 'of', 'Margaret', 'into', 'night', 'and']
    const paragraphs: JSONContent[] = []
    let n = 0
    for (let p = 0; p < 1000; p++) {
      const words: string[] = []
      for (let w = 0; w < 100; w++) words.push(vocab[(n++ * 7 + p) % vocab.length])
      paragraphs.push(para(t(words.join(' ') + '.')))
    }
    const ed = mountAll({ type: 'doc', content: paragraphs })
    const words = ed.state.doc.textBetween(0, ed.state.doc.content.size, ' ').split(/\s+/).length
    expect(words).toBe(100_000)

    const tp = performance.now()
    const pure = findMatches(ed.state.doc, 'e', { caseSensitive: false, wholeWord: false })
    const pureMs = performance.now() - tp

    act(() => useStore.setState((s) => ({ find: { ...s.find, open: false, query: 'lantern' } })))
    const t0 = performance.now()
    act(() => scanNow())
    const findMs = performance.now() - t0
    const found = getMatches().length
    expect(found).toBe(10_000)

    act(() => useStore.setState((s) => ({ find: { ...s.find, query: 'the' } })))
    const t1 = performance.now()
    act(() => scanNow())
    const findCommonMs = performance.now() - t1
    const commonCount = getMatches().length

    // Re-scan after an edit that does not change any match: no decoration rebuild.
    act(() => {
      ed.commands.insertContentAt(1, 'x')
    })
    const tr0 = performance.now()
    act(() => scanNow())
    const rescanMs = performance.now() - tr0

    // Very common query: exact count, but only a window of highlights.
    act(() => useStore.setState((s) => ({ find: { ...s.find, query: 'e' } })))
    const te = performance.now()
    act(() => scanNow())
    const findEMs = performance.now() - te
    expect(getMatches().length).toBe(pure.length)
    expect(ed.view.dom.querySelectorAll(`.${MATCH_CLASS}`).length).toBeLessThanOrEqual(2 * HIGHLIGHT_WINDOW + 1)

    act(() => useStore.setState((s) => ({ find: { ...s.find, query: 'lantern', replacement: 'candle' } })))
    const t2 = performance.now()
    let replaced = 0
    act(() => {
      replaced = replaceAll()
    })
    const replaceMs = performance.now() - t2
    expect(replaced).toBe(10_000)
    expect(ed.state.doc.textContent.includes('lantern')).toBe(false)

    const t3 = performance.now()
    act(() => key(ed.view.dom, 'z', { ctrlKey: true }))
    const undoMs = performance.now() - t3
    expect(ed.state.doc.textContent.includes('candle')).toBe(false)

    const t4 = performance.now()
    act(() => {
      ed.commands.insertContent('x')
    })
    const typeMs = performance.now() - t4

    console.info(
      `[perf] ${words} words: findMatches("e") pure ${pure.length} matches ${pureMs.toFixed(0)} ms; find all "lantern" (${found} matches, incl. decorations) ${findMs.toFixed(0)} ms; ` +
        `find "the" (${commonCount} matches) ${findCommonMs.toFixed(0)} ms; rescan after edit ${rescanMs.toFixed(0)} ms; ` +
        `find "e" (${pure.length} matches, ${2 * HIGHLIGHT_WINDOW + 1} highlighted) ${findEMs.toFixed(0)} ms; replace all ${replaced} ${replaceMs.toFixed(0)} ms; ` +
        `undo ${undoMs.toFixed(0)} ms; next keystroke ${typeMs.toFixed(1)} ms`,
    )
    expect(findMs).toBeLessThan(2_000)
    expect(replaceMs).toBeLessThan(5_000)
    expect(typeMs).toBeLessThan(200)
  }, 60_000)
})
