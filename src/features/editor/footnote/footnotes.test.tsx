import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { closeHistory } from '@tiptap/pm/history'
import { NodeSelection, TextSelection } from '@tiptap/pm/state'
import { useStore } from '@/shared/store'
import { getDocJSON, getEditor, NovelEditor, setDocJSON, INSERT_ITEMS } from '../index'
import type { Editor, JSONContent } from '../index'
import { installLayoutPolyfills } from '../jsdom-polyfills.test-util'
import { closeFootnoteEditor, getFootnoteEditing } from './editing'
import { footnotesOf } from './numbering'
import { getFootnotes } from './api'
import { activeFootnoteView, flattenPasted } from './FootnoteEditor'
import { Fragment, Slice } from '@tiptap/pm/model'
import { newComment, submitDraft } from '@/features/comments'

beforeAll(installLayoutPolyfills)
afterEach(() => {
  act(() => closeFootnoteEditor())
  cleanup()
  act(() => useStore.getState().bookActions.resetBook())
  setDocJSON({ type: 'doc', content: [{ type: 'paragraph' }] })
})

const text = (t: string): JSONContent => ({ type: 'text', text: t })
const fn = (t: string): JSONContent => ({ type: 'footnote', ...(t ? { content: [text(t)] } : {}) })
const p = (...content: JSONContent[]): JSONContent => ({ type: 'paragraph', content })
const title = (t: string): JSONContent => ({ type: 'heading', attrs: { level: 1 }, content: [text(t)] })

function mount(content: JSONContent[]): Editor {
  render(<NovelEditor />)
  setDocJSON({ type: 'doc', content })
  return getEditor()!
}
const labels = (ed: Editor) => footnotesOf(ed.state).map((r) => r.label)
const marks = (ed: Editor) => Array.from(ed.view.dom.querySelectorAll('[data-footnote-ref]'), (el) => el.getAttribute('data-fn-num'))
const flush = () => act(() => new Promise<void>((r) => queueMicrotask(r)))

describe('footnote schema', () => {
  it('is an inline atom whose content is the note text; round-trips through JSON', () => {
    const doc = { type: 'doc', content: [p(text('A claim'), fn('Source, p. 4.'), text(' and more.'))] }
    const ed = mount(doc.content)
    const node = ed.state.doc.firstChild!.child(1)
    expect(node.type.name).toBe('footnote')
    expect(node.isInline && node.type.spec.atom).toBe(true)
    expect(node.textContent).toBe('Source, p. 4.')
    expect(getDocJSON()).toEqual(doc)
  })

  it('keeps marks inside the note and on the reference', () => {
    const note: JSONContent = { type: 'footnote', marks: [{ type: 'italic' }], content: [{ type: 'text', marks: [{ type: 'bold' }], text: 'Bold' }] }
    const ed = mount([p(text('x'), note)])
    expect(getDocJSON()).toEqual({ type: 'doc', content: [p(text('x'), note)] })
    expect(ed.state.doc.firstChild!.child(1).marks.map((m) => m.type.name)).toEqual(['italic'])
  })

  it('loads Phase 1 and Phase 2 documents unchanged (additive schema)', () => {
    const doc = { type: 'doc', content: [title('One'), p(text('Plain text.'))] }
    mount(doc.content)
    expect(getDocJSON()).toEqual(doc)
  })

  it('renders only the derived mark in the text; the note text is not in the line', () => {
    const ed = mount([p(text('A'), fn('Hidden note'))])
    const ref = ed.view.dom.querySelector('[data-footnote-ref]')!
    expect(ref.textContent).toBe('')
    expect(ref.getAttribute('data-fn-num')).toBe('1')
    expect(ref.getAttribute('aria-label')).toBe('Footnote 1')
    expect(ed.view.dom.textContent).not.toContain('Hidden note')
  })

  it('copies as HTML with its note; plain text keeps the body only', () => {
    const ed = mount([p(text('A'), fn('Note'), text('B'))])
    const slice = ed.state.doc.slice(1, ed.state.doc.firstChild!.nodeSize - 1)
    const html = ed.getHTML()
    expect(html).toContain('<sup data-footnote="" class="nv-fn-ref">Note</sup>')
    expect(ed.getText()).toBe('AB')
    // Paste the HTML back: the note survives.
    act(() => {
      ed.commands.setContent(html)
    })
    expect(ed.state.doc.firstChild!.child(1).textContent).toBe('Note')
    expect(slice.content.childCount).toBe(3)
  })
})

describe('numbering (derived, never stored)', () => {
  it('numbers through the book and updates live when notes are added or removed', () => {
    const ed = mount([p(text('a'), fn('1'), text('b'), fn('2')), p(text('c'), fn('3'))])
    expect(labels(ed)).toEqual(['1', '2', '3'])
    expect(marks(ed)).toEqual(['1', '2', '3'])
    // Insert one at the start: everything after renumbers.
    act(() => {
      ed.view.dispatch(ed.state.tr.setSelection(TextSelection.create(ed.state.doc, 1)))
      ed.commands.insertFootnote()
    })
    expect(labels(ed)).toEqual(['1', '2', '3', '4'])
    expect(marks(ed)).toEqual(['1', '2', '3', '4'])
    expect(ed.state.doc.firstChild!.firstChild!.type.name).toBe('footnote')
    // Delete the first reference: its note goes with it, in one undo step.
    act(() => void ed.view.dispatch(closeHistory(ed.state.tr.delete(1, 3))))
    expect(labels(ed)).toEqual(['1', '2', '3'])
    expect(ed.state.doc.textContent).not.toContain('\u0000')
    act(() => void ed.commands.undo())
    expect(labels(ed)).toEqual(['1', '2', '3', '4'])
    expect(getDocJSON()).not.toHaveProperty('content.0.attrs.number')
  })

  it('restarts per chapter when set (front matter counts on its own)', () => {
    const ed = mount([p(text('pre'), fn('a')), title('One'), p(text('x'), fn('b'), fn('c')), title('Two'), p(text('y'), fn('d'))])
    expect(labels(ed)).toEqual(['1', '2', '3', '4'])
    act(() => useStore.getState().bookActions.setFootnotes((f) => ({ ...f, numbering: 'chapter' })))
    expect(labels(ed)).toEqual(['1', '1', '2', '1'])
    expect(marks(ed)).toEqual(['1', '1', '2', '1'])
    expect(footnotesOf(ed.state).map((r) => r.chapter)).toEqual([-1, 0, 0, 1])
  })

  it('symbols: *, †, ‡ ...', () => {
    const ed = mount([p(text('a'), fn('1'), fn('2'), fn('3'), fn('4'), fn('5'), fn('6'), fn('7'))])
    act(() => useStore.getState().bookActions.setFootnotes({ format: 'symbols' }))
    expect(labels(ed)).toEqual(['*', '†', '‡', '§', '‖', '¶', '**'])
    expect(marks(ed)[2]).toBe('‡')
    expect(getFootnotes().map((r) => r.ordinal)).toEqual([0, 1, 2, 3, 4, 5, 6])
  })
})

describe('commands', () => {
  it('Insert > Footnote (Mod-Alt-f) inserts after the selection, keeps the caret after it and opens the note', async () => {
    const ed = mount([p(text('Hello world'))])
    act(() => void ed.view.dispatch(ed.state.tr.setSelection(TextSelection.create(ed.state.doc, 1, 6))))
    const item = INSERT_ITEMS.find((i) => i.id === 'footnote.insert')!
    expect(item.shortcut).toBe('Mod-Alt-f')
    act(() => item.run(ed))
    await flush()
    const node = ed.state.doc.firstChild!.child(1)
    expect(node.type.name).toBe('footnote')
    expect(ed.state.doc.firstChild!.firstChild!.text).toBe('Hello')
    expect(ed.state.selection.from).toBe(8)
    expect(getFootnoteEditing()?.pos).toBe(6)
    // The footnote editor (popover) shows the note and is focused.
    const box = await screen.findByTestId('footnote-editor')
    expect(box).toHaveAttribute('contenteditable', 'true')
  })

  it('cannot insert where inline content is not allowed (a selected page break)', () => {
    const ed = mount([p(text('a')), { type: 'pageBreak' }, p(text('b'))])
    act(() => void ed.view.dispatch(ed.state.tr.setSelection(NodeSelection.create(ed.state.doc, 3))))
    expect(ed.commands.insertFootnote()).toBe(false)
  })

  it('Enter on a selected reference opens its note; a click on the reference too', async () => {
    const ed = mount([p(text('a'), fn('note'), text('b'))])
    act(() => void ed.view.dispatch(ed.state.tr.setSelection(NodeSelection.create(ed.state.doc, 2))))
    act(() => {
      ed.view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })
    expect(getFootnoteEditing()?.pos).toBe(2)
    act(() => closeFootnoteEditor())
    fireEvent.click(ed.view.dom.querySelector('[data-footnote-ref]')!)
    expect(getFootnoteEditing()?.pos).toBe(2)
  })
})

describe('footnote editor (nested view, unified undo)', () => {
  async function openOn(ed: Editor, pos: number) {
    act(() => void ed.commands.editFootnote(pos))
    return (await screen.findByTestId('footnote-editor')) as HTMLElement
  }

  it('typing in the note edits the manuscript; Mod-z there undoes in the manuscript; Escape returns to the reference', async () => {
    const ed = mount([p(text('a'), fn('note'), text('b'))])
    const box = await openOn(ed, 2)
    expect(box.textContent).toBe('note')
    // jsdom has no text input: insert through the nested view, as its input handling would.
    const inner = activeFootnoteView()!
    expect(inner.dom).toBe(box)
    act(() => void inner.dispatch(inner.state.tr.insertText('s!', inner.state.selection.from)))
    expect(ed.state.doc.firstChild!.child(1).textContent).toBe('notes!')
    expect(box.textContent).toBe('notes!')
    act(() => {
      box.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, metaKey: false, bubbles: true, cancelable: true }))
    })
    expect(ed.state.doc.firstChild!.child(1).textContent).toBe('note')
    expect(box.textContent).toBe('note')
    act(() => {
      box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    expect(getFootnoteEditing()).toBeNull()
    expect(ed.state.selection.from).toBe(2 + ed.state.doc.firstChild!.child(1).nodeSize)
  })

  it('pasting commented text into a note follows the comment paste rule of the manuscript', async () => {
    const ed = mount([p(text('quick'), fn('note'))])
    act(() => void ed.view.dispatch(ed.state.tr.setSelection(TextSelection.create(ed.state.doc, 1, 6))))
    act(() => void newComment())
    let id: string | null = null
    act(() => void (id = submitDraft('about this')))
    expect(id).not.toBeNull()
    const copied = ed.state.doc.slice(1, 6)
    await openOn(ed, 6)
    const inner = activeFootnoteView()!
    const paste = (s: Slice) => {
      let out = s
      inner.someProp('transformPasted', (f) => void (out = f(out, inner, false)))
      let marked = false
      out.content.descendants((n) => void (marked ||= n.marks.some((m) => m.type.name === 'comment' && m.attrs.id === id)))
      return marked
    }
    // A copy while the thread is anchored in the manuscript: no duplicate anchor in the note.
    expect(paste(copied)).toBe(false)
    // After a cut the thread is no longer anchored: pasting into the note moves it there.
    act(() => void ed.view.dispatch(ed.state.tr.delete(1, 6)))
    expect(paste(copied)).toBe(true)
    act(() => closeFootnoteEditor())
    act(() => useStore.getState().commentsActions.threadsChanged([], 0))
  })

  it('closes when its footnote is deleted from the manuscript', async () => {
    const ed = mount([p(text('a'), fn('note'), text('b'))])
    await openOn(ed, 2)
    act(() => void ed.view.dispatch(ed.state.tr.delete(2, 2 + ed.state.doc.firstChild!.child(1).nodeSize)))
    expect(getFootnoteEditing()).toBeNull()
  })

  it('CRITICAL: a document load closes the note editor; its edits never reach another document', async () => {
    const ed = mount([p(text('a'), fn('note'), text('b'))])
    await openOn(ed, 2)
    const inner = activeFootnoteView()!
    // Open / recent / new / recovery all load through setDocJSON.
    act(() => setDocJSON({ type: 'doc', content: [p(text('Another book entirely.'))] }))
    expect(getFootnoteEditing()).toBeNull()
    // Even a stale nested view (a load the editor missed) forwards nothing.
    act(() => void inner.dispatch(inner.state.tr.insertText('X', 1)))
    expect(ed.state.doc.textContent).toBe('Another book entirely.')
  })

  it('forwards nothing when the manuscript no longer holds this note (state replaced without a transaction)', async () => {
    const ed = mount([p(text('a'), fn('note'), text('b'))])
    await openOn(ed, 2)
    const inner = activeFootnoteView()!
    const other = ed.state.apply(ed.state.tr.insertText('zz', 1))
    act(() => ed.view.updateState(other))
    act(() => void inner.dispatch(inner.state.tr.insertText('X', 1)))
    expect(ed.state.doc.textContent).toBe('zzanoteb')
    expect(getFootnoteEditing()).toBeNull()
  })

  it('the first Mod-z after inserting a footnote undoes only the typing in it', async () => {
    const ed = mount([p(text('Hello'))])
    act(() => void ed.view.dispatch(ed.state.tr.setSelection(TextSelection.create(ed.state.doc, 6))))
    act(() => void ed.commands.insertFootnote())
    await flush()
    await screen.findByTestId('footnote-editor')
    const inner = activeFootnoteView()!
    act(() => void inner.dispatch(inner.state.tr.insertText('typed', 0)))
    expect(ed.state.doc.firstChild!.child(1).textContent).toBe('typed')
    act(() => {
      inner.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }))
    })
    expect(ed.state.doc.firstChild!.childCount).toBe(2)
    expect(ed.state.doc.firstChild!.child(1).type.name).toBe('footnote')
    expect(ed.state.doc.firstChild!.child(1).textContent).toBe('')
  })

  it('pasted paragraphs become one run of text joined by spaces', () => {
    const ed = mount([p(text('x'))])
    const schema = ed.schema
    const slice = new Slice(Fragment.from([schema.nodes.paragraph.create(null, schema.text('One.')), schema.nodes.paragraph.create(null, schema.text('Two.'))]), 0, 0)
    const flat = flattenPasted(slice, schema)
    expect(flat.content.textBetween(0, flat.content.size)).toBe('One. Two.')
    expect(flat.openStart).toBe(0)
  })

  it('Tab and Shift-Tab cycle between the note and Done (never out of the popover)', async () => {
    const ed = mount([p(text('a'), fn('note'), text('b'))])
    const box = await openOn(ed, 2)
    const done = document.querySelector<HTMLElement>('[data-control-id="footnote.done"]')!
    box.focus()
    fireEvent.keyDown(box, { key: 'Tab' })
    expect(document.activeElement).toBe(done)
    fireEvent.keyDown(done, { key: 'Tab' })
    expect(document.activeElement).toBe(box)
    fireEvent.keyDown(box, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(done)
    expect(getFootnoteEditing()).not.toBeNull()
  })

  it('REGRESSION: Escape and Tab during an IME composition belong to the IME (the note stays open, focus stays)', async () => {
    const ed = mount([p(text('a'), fn('note'), text('b'))])
    const box = await openOn(ed, 2)
    // The nested view is composing, so its own keymap steps aside (as in a browser); the popover must too.
    Object.defineProperty(activeFootnoteView()!, 'composing', { configurable: true, get: () => true })
    box.focus()
    const press = (init: KeyboardEventInit & { keyCode?: number }) =>
      act(() => void box.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })))
    press({ key: 'Escape', isComposing: true })
    expect(getFootnoteEditing()).not.toBeNull()
    press({ key: 'Tab', isComposing: true })
    expect(document.activeElement).toBe(box)
    // WebKit and older engines report composition keys as keyCode 229 (isComposing may be false).
    press({ key: 'Escape', keyCode: 229 })
    press({ key: 'Tab', keyCode: 229 })
    expect(getFootnoteEditing()).not.toBeNull()
    expect(document.activeElement).toBe(box)
  })
})

