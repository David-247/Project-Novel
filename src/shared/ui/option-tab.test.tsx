import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { Button } from './Button'
import { Dialog } from './Dialog'
import { loopOptionTab } from './option-tab'

const key = (init: Partial<KeyboardEvent>) => new KeyboardEvent('keydown', { key: 'Tab', altKey: true, cancelable: true, ...init })

describe('loopOptionTab: Option+Tab loops inside a dialog like a plain Tab', () => {
  afterEach(() => (document.body.innerHTML = ''))

  function setup() {
    document.body.innerHTML = `
      <div id="root">
        <button id="close">Close</button>
        <input id="title" />
        <button id="off" disabled>Off</button>
        <input type="radio" name="g" id="r1" checked /><input type="radio" name="g" id="r2" />
        <button id="hidden" hidden>Hidden</button>
        <span tabindex="-1" id="skip">x</span>
        <button id="next">Next</button>
      </div>`
    return document.getElementById('root')!
  }
  const focus = (id: string) => document.getElementById(id)!.focus()
  const active = () => document.activeElement?.id

  it('past the last stop to the first; Shift before the first to the last', () => {
    const root = setup()
    focus('next')
    const fwd = key({})
    expect(loopOptionTab(fwd, root)).toBe(true)
    expect(fwd.defaultPrevented).toBe(true)
    expect(active()).toBe('close')
    expect(loopOptionTab(key({ shiftKey: true }), root)).toBe(true)
    expect(active()).toBe('next')
  })

  it('forward, a dialog that can take the focus takes it, and the browser moves on to the first stop', async () => {
    const root = setup()
    root.tabIndex = -1
    focus('next')
    const fwd = key({})
    expect(loopOptionTab(fwd, root)).toBe(true)
    // Not prevented: the browser's own Option+Tab continues from the dialog (its first stop: Close).
    expect(fwd.defaultPrevented).toBe(false)
    expect(document.activeElement).toBe(root)
    // jsdom's Tab moves nothing: the focus is finished on the first stop.
    await new Promise((r) => setTimeout(r, 0))
    expect(active()).toBe('close')
    // Backward still focuses the last stop itself.
    focus('close')
    expect(loopOptionTab(key({ shiftKey: true }), root)).toBe(true)
    expect(active()).toBe('next')
  })

  it('in the middle, or for a plain Tab, the browser (and the focus trap) move the focus', () => {
    const root = setup()
    focus('title')
    expect(loopOptionTab(key({}), root)).toBe(false)
    expect(loopOptionTab(key({ shiftKey: true }), root)).toBe(false)
    focus('next')
    expect(loopOptionTab(key({ altKey: false }), root)).toBe(false)
    expect(loopOptionTab(key({ key: 'n' }), root)).toBe(false)
    expect(active()).toBe('next')
  })
})

describe('the shared Dialog loops Option+Tab (Settings, Go to Page, Word Count, ...)', () => {
  it('Option+Tab from the last control goes to the first; Shift+Option+Tab from the first to the last', async () => {
    render(
      <Dialog open onOpenChange={() => {}} title="Go to Page" footer={<Button>Go to</Button>}>
        <input aria-label="Page" />
      </Dialog>,
    )
    const close = screen.getByRole('button', { name: 'Close' })
    const go = screen.getByRole('button', { name: 'Go to' })
    go.focus()
    fireEvent.keyDown(go, { key: 'Tab', altKey: true })
    // The dialog takes the focus, then (no browser Tab in jsdom) its first control.
    await new Promise((r) => setTimeout(r, 0))
    expect(document.activeElement).toBe(close)
    fireEvent.keyDown(close, { key: 'Tab', altKey: true, shiftKey: true })
    expect(document.activeElement).toBe(go)
  })

  it('a key from a dialog over it is left to that dialog', () => {
    const outer = document.createElement('div')
    outer.innerHTML = '<button id="a">A</button><button id="b">B</button>'
    const inner = document.createElement('button')
    document.body.append(outer, inner)
    inner.focus()
    const e = new KeyboardEvent('keydown', { key: 'Tab', altKey: true, cancelable: true })
    Object.defineProperty(e, 'target', { value: inner })
    expect(loopOptionTab(e, outer)).toBe(false)
    expect(outer.contains(document.activeElement)).toBe(false)
  })
})
