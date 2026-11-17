import { act, cleanup, render, waitFor } from '@testing-library/react'
import { TextSelection } from '@tiptap/pm/state'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { getActiveEditor, getEditor, setDocJSON, type JSONContent } from '@/features/editor'
import { REWRITE_CONTROLS } from '@/features/rewrite'
import { getReviewView, TRACK_CHANGES_CONTROLS as TC } from '@/features/track-changes'
import { getCommand, getCommands, isCommandEnabled } from '@/shared/commands'
import { useStore } from '@/shared/store'
import { App } from './App'

// Merge of the re-write view (T8) with the track changes review (T7) and the ribbon (T6), in the whole app.

beforeAll(() => {
  const rect = { x: 0, y: 0, top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0, toJSON: () => ({}) }
  const emptyRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList
  Range.prototype.getClientRects ??= emptyRects
  Range.prototype.getBoundingClientRect ??= () => rect as DOMRect
  Element.prototype.getClientRects ??= emptyRects
  Element.prototype.scrollIntoView ??= () => {}
  Element.prototype.hasPointerCapture ??= () => false
  Element.prototype.releasePointerCapture ??= () => {}
  document.elementFromPoint ??= () => null
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})

afterEach(() => {
  act(() => getCommand(REWRITE_CONTROLS.close.id)?.run())
  cleanup()
  useStore.getState().rewriteActions.loaded([])
  setDocJSON({ type: 'doc', content: [{ type: 'paragraph' }] })
})

const DATE = '2026-01-01T00:00:00.000Z'
const para = (...content: JSONContent[]): JSONContent => ({ type: 'paragraph', content })
const text = (t: string, marks?: JSONContent['marks']): JSONContent => ({ type: 'text', text: t, ...(marks ? { marks } : {}) })
const DOC: JSONContent[] = [
  para(text('Alpha line.')),
  para(text('Beta line.')),
  para(text('Gamma '), text('added', [{ type: 'insertion', attrs: { id: 'c1', author: 'Ann', date: DATE } }]), text(' line.')),
]

const enabled = (id: string) => {
  const c = getCommand(id)
  expect(c, id).toBeDefined()
  return isCommandEnabled(c!)
}
const button = (controlId: string) => document.querySelector<HTMLButtonElement>(`[data-control-id="${controlId}"]`)
const hasInsertion = () => {
  let found = false
  getEditor()!.state.doc.descendants((n) => {
    if (n.marks.some((m) => m.type.name === 'insertion')) found = true
  })
  return found
}

async function renderApp() {
  render(<App />)
  await waitFor(() => expect(getEditor()).not.toBeNull())
  await waitFor(() => expect(getCommands().length).toBeGreaterThan(50))
  act(() => setDocJSON({ type: 'doc', content: DOC }))
}

/** Caret in the first paragraph, then Re-write Passage… (the view opens over the pages). */
function openRewrite() {
  const ed = getEditor()!
  act(() => ed.view.dispatch(ed.state.tr.setSelection(TextSelection.create(ed.state.doc, 2))))
  act(() => getCommand(REWRITE_CONTROLS.open.id)!.run())
  expect(useStore.getState().rewrite.openId).not.toBeNull()
}

describe('re-write view with the track changes review and the ribbon', () => {
  it('opening and closing a re-write leaves Next Change / Accept All acting on the manuscript', async () => {
    await renderApp()
    const manuscript = getEditor()!
    expect(enabled(TC.nextChange.id)).toBe(true)
    openRewrite()
    // The review acts on the manuscript, which the view hides: off while it is open.
    expect(getReviewView()).toBe(manuscript.view)
    for (const id of [TC.prevChange.id, TC.nextChange.id, TC.showChange.id, TC.accept.id, TC.acceptAll.id, TC.reject.id, TC.rejectAll.id]) expect(enabled(id), id).toBe(false)
    act(() => getCommand(REWRITE_CONTROLS.close.id)!.run())
    expect(useStore.getState().rewrite.openId).toBeNull()
    // Back on the manuscript: the review side is the manuscript's, never the closed revision's.
    expect(getReviewView()).toBe(manuscript.view)
    expect(getActiveEditor()).toBe(manuscript)
    expect(enabled(TC.nextChange.id)).toBe(true)
    act(() => getCommand(TC.nextChange.id)!.run())
    await waitFor(() => {
      const { from } = manuscript.state.selection
      const third = manuscript.state.doc.child(0).nodeSize + manuscript.state.doc.child(1).nodeSize
      expect(from).toBeGreaterThan(third)
    })
    expect(enabled(TC.acceptAll.id)).toBe(true)
    await act(async () => {
      getCommand(TC.acceptAll.id)!.run()
      await Promise.resolve()
    })
    await waitFor(() => expect(hasInsertion()).toBe(false))
    expect(manuscript.state.doc.child(2).textContent).toBe('Gamma added line.')
  })

  it('the ribbon follows the command gate while a re-write is open (enabled state and target editor)', async () => {
    await renderApp()
    // Review > Re-write: Re-write Passage… (with an icon), Re-writes…, Previous / Next Re-write, Keep Original / Keep This Version.
    const group = document.querySelector('[data-ribbon-group="review.rewrite"]')!
    expect(Array.from(group.querySelectorAll('[data-control-id]'), (b) => b.getAttribute('data-control-id'))).toEqual([
      'ribbon.cmd.rewrite.open',
      'ribbon.cmd.rewrite.list',
      'ribbon.cmd.rewrite.prev',
      'ribbon.cmd.rewrite.next',
    ])
    // The choice shows only while a re-write is open.
    expect(button('ribbon.cmd.rewrite.keepVersion')).toBeNull()
    expect(button('ribbon.cmd.rewrite.open')!.querySelector('svg')).not.toBeNull()
    expect(button('ribbon.cmd.rewrite.open')!.disabled).toBe(false)
    expect(button('ribbon.cmd.review.change.next')!.disabled).toBe(false)
    openRewrite()
    await waitFor(() => expect(button('ribbon.cmd.rewrite.open')!.disabled).toBe(true))
    // Manuscript-wide controls are off: registry buttons and the slices' own controls alike.
    for (const id of ['ribbon.cmd.review.change.next', 'ribbon.cmd.review.accept', 'ribbon.cmd.edit.replace', 'ribbon.cmd.footnote.insert', 'find.open', 'comment.new', 'review.track'])
      expect(button(id)?.disabled, id).toBe(true)
    // Re-writes… stays on (there is one now), and the choice is on.
    expect(button('ribbon.cmd.rewrite.list')!.disabled).toBe(false)
    await waitFor(() => expect(button('ribbon.cmd.rewrite.keepVersion')!.disabled).toBe(false))
    expect(button('ribbon.cmd.rewrite.keepOriginal')!.disabled).toBe(false)
    // Formatting: the target is the active editor (the revision while it has the focus), never the
    // hidden manuscript; with no editor active the controls are off.
    const active = getActiveEditor()
    expect(active).not.toBe(getEditor())
    if (active === null) expect(button('toolbar.bold')!.disabled).toBe(true)
    act(() => getCommand(REWRITE_CONTROLS.close.id)!.run())
    await waitFor(() => expect(button('ribbon.cmd.review.change.next')!.disabled).toBe(false))
    for (const id of ['find.open', 'comment.new', 'review.track', 'toolbar.bold']) expect(button(id)?.disabled, id).toBe(false)
  })
})
