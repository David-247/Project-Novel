// The reload guard (app-shell) together with the real editor: editor shortcuts that share a reload
// combo (Align right = Mod-Shift-r) must still work while the guard is on, as in built apps.
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { useReloadGuard } from '@/features/app-shell'
import { getEditor, NovelEditor, setDocJSON } from '@/features/editor'
import { installLayoutPolyfills } from '@/features/editor/jsdom-polyfills.test-util'

function Guarded() {
  useReloadGuard(true)
  return <NovelEditor />
}

const key = (target: EventTarget, init: KeyboardEventInit) => {
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  target.dispatchEvent(e)
  return e
}

beforeAll(installLayoutPolyfills)
afterEach(() => {
  cleanup()
  setDocJSON({ type: 'doc', content: [{ type: 'paragraph' }] })
})

describe('reload guard with the real editor (guard enabled)', () => {
  it('Mod-Shift-R in the editor aligns right (and its default is still prevented)', () => {
    render(<Guarded />)
    const ed = getEditor()!
    act(() => {
      setDocJSON({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Right.' }] }] })
      ed.commands.focus('end')
    })
    let e!: KeyboardEvent
    act(() => {
      // key 'r' as in toolbar.test (jsdom has no keyCode for prosemirror-keymap's shifted-key fallback).
      e = key(ed.view.dom, { key: 'r', code: 'KeyR', ctrlKey: true, shiftKey: true })
    })
    expect(ed.state.doc.child(0).attrs.textAlign).toBe('right')
    expect(e.defaultPrevented).toBe(true) // by the editor's keymap: no browser hard reload
  })

  it('F5, Ctrl+R and Ctrl+Shift+R outside the editor are still prevented', () => {
    render(<Guarded />)
    expect(key(document.body, { key: 'F5' }).defaultPrevented).toBe(true)
    expect(key(document.body, { key: 'r', ctrlKey: true }).defaultPrevented).toBe(true)
    expect(key(document.body, { key: 'R', ctrlKey: true, shiftKey: true }).defaultPrevented).toBe(true)
    // F5 inside the editor too (the editor does not handle it).
    expect(key(getEditor()!.view.dom, { key: 'F5' }).defaultPrevented).toBe(true)
  })
})
