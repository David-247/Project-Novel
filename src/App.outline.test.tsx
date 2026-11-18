import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { flushWordCount, getEditor, setDocJSON } from '@/features/editor'
import { outlineDebug } from '@/features/outline'
import { auditTooltipCoverage, formatCoverageProblems } from '@/features/tooltips'
import { buildMenuModel, getCommand, getCommands, runCommand, type MenuNode } from '@/shared/commands'
import { useStore } from '@/shared/store'
import { App } from './App'

// The navigation pane in the whole app (jsdom: no layout, so no page ranges; e2e covers those).

beforeAll(() => {
  const rect = { x: 0, y: 0, top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0, toJSON: () => ({}) }
  const emptyRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList
  Range.prototype.getClientRects ??= emptyRects
  Range.prototype.getBoundingClientRect ??= () => rect as DOMRect
  Element.prototype.getClientRects ??= emptyRects
  Element.prototype.scrollIntoView ??= () => {}
  Element.prototype.hasPointerCapture ??= () => false
  Element.prototype.setPointerCapture ??= () => {}
  Element.prototype.releasePointerCapture ??= () => {}
  document.elementFromPoint ??= () => null
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})

const t = (s: string) => ({ type: 'text', text: s })
const DOC = {
  type: 'doc',
  content: [
    { type: 'paragraph', content: [t('For my readers')] },
    { type: 'heading', attrs: { level: 1 }, content: [t('The Storm')] },
    { type: 'paragraph', content: [t('One two three')] },
    { type: 'heading', attrs: { level: 2 }, content: [t('At sea')] },
    { type: 'paragraph', content: [t('Four five')] },
    { type: 'heading', attrs: { level: 1 } },
    { type: 'paragraph', content: [t('Six seven')] },
  ],
}

beforeEach(() => useStore.getState().preferencesActions.set('navigationPane', false))
afterEach(() => {
  cleanup()
  setDocJSON({ type: 'doc', content: [{ type: 'paragraph' }] })
})

async function renderApp() {
  render(<App />)
  await waitFor(() => expect(getEditor()).not.toBeNull())
  await waitFor(() => expect(getCommand('view.navigationPane')).toBeDefined())
  act(() => setDocJSON(DOC as Parameters<typeof setDocJSON>[0]))
  act(() => flushWordCount())
}

const pane = () => screen.getByRole('complementary', { name: 'Navigation' })
const tree = () => within(pane()).getByRole('tree', { name: 'Headings' })
const rows = () => within(tree()).getAllByRole('treeitem')

describe('navigation pane (View ▸ Navigation Pane)', () => {
  it('opens from the command (View menu, ribbon, Ctrl/Cmd+Shift+O) and lists front matter, chapters and subheadings with counts', async () => {
    await renderApp()
    expect(screen.queryByRole('complementary', { name: 'Navigation' })).toBeNull()
    const cmd = getCommand('view.navigationPane')!
    expect(cmd.shortcut).toBe('Mod-Shift-o')
    expect(cmd.isChecked?.()).toBe(false)
    // In the View menu, checkable, before Comments Panel.
    const view = buildMenuModel(getCommands(), 'in-app').find((m) => m.id === 'view')!
    const items = view.children.flatMap(function flat(n: MenuNode): MenuNode[] {
      return n.kind === 'submenu' ? n.children.flatMap(flat) : [n]
    })
    const ids = items.map((n) => (n.kind === 'item' ? n.command.id : ''))
    expect(ids.indexOf('view.navigationPane')).toBeGreaterThanOrEqual(0)
    expect(ids.indexOf('view.navigationPane')).toBeLessThan(ids.indexOf('comment.panel'))

    act(() => runCommand('view.navigationPane'))
    await waitFor(() => expect(rows()).toHaveLength(4))
    expect(cmd.isChecked?.()).toBe(true)
    expect(useStore.getState().preferences.navigationPane).toBe(true)
    expect(rows().map((r) => r.getAttribute('aria-label'))).toEqual([
      'Front matter, 3 words',
      'Chapter 1: The Storm, 9 words',
      'At sea, 4 words',
      'Chapter 2: Untitled chapter 2, 2 words',
    ])
    expect(rows().map((r) => r.getAttribute('aria-level'))).toEqual(['1', '1', '2', '1'])
    expect(rows()[1]).toHaveAttribute('aria-expanded', 'true')
    expect(within(pane()).getByTestId('outline-total')).toHaveTextContent('14 words')
    // The focus moved to the tree (the current heading: the caret is at the start, in front matter).
    await waitFor(() => expect(document.activeElement).toBe(rows()[0]))
    expect(formatCoverageProblems(auditTooltipCoverage(pane()))).toBe('')
  })

  it('the tree from the keyboard: arrows, Home / End, Left / Right fold, type-ahead, Enter jumps and returns the focus', async () => {
    await renderApp()
    act(() => runCommand('view.navigationPane'))
    await waitFor(() => expect(document.activeElement).toBe(rows()[0]))
    const key = (k: string) => fireEvent.keyDown(document.activeElement!, { key: k })
    key('ArrowDown')
    expect(document.activeElement).toBe(rows()[1])
    // Only one row is in the tab order (roving tabindex).
    expect(rows().filter((r) => r.tabIndex === 0)).toEqual([rows()[1]])
    key('ArrowLeft')
    expect(rows()).toHaveLength(3)
    expect(rows()[1]).toHaveAttribute('aria-expanded', 'false')
    key('ArrowRight')
    expect(rows()).toHaveLength(4)
    key('ArrowRight')
    expect(document.activeElement).toBe(rows()[2])
    key('ArrowLeft')
    expect(document.activeElement).toBe(rows()[1])
    key('End')
    expect(document.activeElement).toBe(rows()[3])
    key('Home')
    expect(document.activeElement).toBe(rows()[0])
    // Type-ahead: "a" finds "At sea"; "u" the untitled chapter.
    key('a')
    expect(document.activeElement).toBe(rows()[2])
    await new Promise((r) => setTimeout(r, 700))
    key('u')
    expect(document.activeElement).toBe(rows()[3])
    // Enter: the caret to that chapter, the focus back in the manuscript.
    key('Enter')
    const ed = getEditor()!
    const untitledFrom = useStore.getState().wordCount.chapters[1].from
    expect(ed.state.selection.head).toBe(untitledFrom + 1)
    await waitFor(() => expect(ed.view.hasFocus() || document.activeElement === ed.view.dom).toBe(true))
  })

  it('a click jumps; the current heading follows the caret; Escape returns to the manuscript; close hides it', async () => {
    await renderApp()
    act(() => runCommand('view.navigationPane'))
    await waitFor(() => expect(rows()).toHaveLength(4))
    fireEvent.click(rows()[2])
    const ed = getEditor()!
    const at = ed.state.selection.head
    expect(ed.state.doc.resolve(at).parent.textContent).toBe('At sea')
    await waitFor(() => expect(rows()[2]).toHaveAttribute('aria-selected', 'true'))
    expect(rows().filter((r) => r.getAttribute('aria-selected') === 'true')).toHaveLength(1)
    // Folding its chapter highlights the chapter instead.
    fireEvent.click(rows()[1].querySelector('[data-outline-toggle]')!)
    await waitFor(() => expect(rows()[1]).toHaveAttribute('aria-selected', 'true'))

    rows()[0].focus()
    fireEvent.keyDown(rows()[0], { key: 'Escape' })
    expect(document.activeElement).toBe(ed.view.dom)
    expect(pane()).toBeTruthy()

    fireEvent.click(within(pane()).getByRole('button', { name: 'Close navigation pane' }))
    expect(screen.queryByRole('complementary', { name: 'Navigation' })).toBeNull()
    expect(useStore.getState().preferences.navigationPane).toBe(false)
  })

  it('live: an edit updates the counts after the word count publish (not on the keystroke)', async () => {
    await renderApp()
    act(() => runCommand('view.navigationPane'))
    await waitFor(() => expect(rows()).toHaveLength(4))
    const builds = outlineDebug.builds
    const ed = getEditor()!
    const end = useStore.getState().wordCount.chapters[1].to
    act(() => {
      ed.view.dispatch(ed.state.tr.insertText(' eight nine', end - 1))
    })
    // Nothing is rebuilt on the keystroke: not in the transaction, nor in the idle time after it (jsdom's
    // idle fallback is a 0 ms task), only after the word count publish (throttled at 150 ms).
    expect(outlineDebug.builds).toBe(builds)
    await act(() => new Promise((r) => setTimeout(r, 60)))
    expect(outlineDebug.builds).toBe(builds)
    act(() => flushWordCount())
    await waitFor(() => expect(rows()[3].getAttribute('aria-label')).toBe('Chapter 2: Untitled chapter 2, 4 words'))
    expect(within(pane()).getByTestId('outline-total')).toHaveTextContent('16 words')
  })

  it('the resize handle: arrow keys change the width, kept in preferences within the limits', async () => {
    await renderApp()
    act(() => runCommand('view.navigationPane'))
    const handle = await within(pane()).findByRole('separator', { name: 'Resize navigation pane' })
    const w0 = useStore.getState().preferences.navigationPaneWidth
    fireEvent.keyDown(handle, { key: 'ArrowRight' })
    expect(useStore.getState().preferences.navigationPaneWidth).toBe(w0 + 16)
    fireEvent.keyDown(handle, { key: 'End' })
    expect(useStore.getState().preferences.navigationPaneWidth).toBe(480)
    fireEvent.keyDown(handle, { key: 'Home' })
    expect(useStore.getState().preferences.navigationPaneWidth).toBe(200)
    expect(pane().style.width).toBe('200px')
  })
})
