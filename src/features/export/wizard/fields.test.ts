import { afterEach, describe, expect, it } from 'vitest'
import { loopOptionTab } from './fields'

const key = (init: Partial<KeyboardEvent>) => new KeyboardEvent('keydown', { key: 'Tab', altKey: true, cancelable: true, ...init })

describe('loopOptionTab: Option+Tab loops inside the wizard like a plain Tab', () => {
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
