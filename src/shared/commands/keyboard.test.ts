import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetCommandsForTests,
  __resetKeyboardForTests,
  installCommandShortcuts,
  registerCommand,
  runFromNativeMenu,
  type Command,
} from './index'

// The webview's keydown and, on macOS, the native menu accelerator for the same press.

let manuscript: HTMLElement
let field: HTMLInputElement
let uninstall = () => {}
const runs: Record<string, number> = {}

function command(id: string, shortcut: string, menu: Command['menu'], extra: Partial<Command> = {}) {
  runs[id] = 0
  registerCommand({ id, label: id, description: `Does ${id}.`, shortcut, menu, run: () => void runs[id]++, ...extra })
}

/** A key press at `target`; `appHandles` = an app handler (the editor keymap) prevents its default first. */
function press(target: Element, key: string, init: KeyboardEventInit = {}, appHandles = false) {
  const e = new KeyboardEvent('keydown', { key, ctrlKey: true, bubbles: true, cancelable: true, ...init })
  if (appHandles) e.preventDefault()
  target.dispatchEvent(e)
  return e
}

beforeEach(() => {
  document.body.innerHTML = '<div id="ms" contenteditable="true"></div><input id="field"><div role="menu"><div role="menuitem" tabindex="-1" id="mi"></div></div>'
  manuscript = document.getElementById('ms')!
  field = document.getElementById('field') as HTMLInputElement
  uninstall = installCommandShortcuts({ manuscript: () => manuscript, platform: 'other' })
  command('history.undo', 'Mod-z', { id: 'edit', group: 'history', order: 1 })
  command('toolbar.bold', 'Mod-b', { id: 'format', group: 'marks', order: 1 })
  command('file.save', 'Mod-s', { id: 'file', group: 'save', order: 1 })
  command('edit.copy', 'Mod-c', { id: 'edit', group: 'clipboard', order: 1 }, { nativeShortcut: true })
})

afterEach(() => {
  uninstall()
  __resetCommandsForTests()
  __resetKeyboardForTests()
  vi.useRealTimers()
})

describe('shortcut dispatcher and the native menu (one press, one run)', () => {
  it('a press the dispatcher ran: the native menu event for it is dropped', () => {
    const e = press(manuscript, 's')
    expect(e.defaultPrevented).toBe(true)
    expect(runFromNativeMenu('file.save', manuscript)).toBe(false)
    expect(runs['file.save']).toBe(1)
  })

  it('a press an app handler handled (editor keymap): not run again, native event dropped', () => {
    press(manuscript, 'b', {}, true)
    expect(runs['toolbar.bold']).toBe(0)
    expect(runFromNativeMenu('toolbar.bold', manuscript)).toBe(false)
  })

  it('a native event with no press just before it (a click on the menu) runs', () => {
    expect(runFromNativeMenu('toolbar.bold', manuscript)).toBe(true)
    expect(runs['toolbar.bold']).toBe(1)
  })

  it('the same press later than SAME_PRESS_MS is a new choice', () => {
    press(manuscript, 's')
    expect(runFromNativeMenu('file.save', manuscript, performance.now() + 1000)).toBe(true)
    expect(runs['file.save']).toBe(2)
  })

  it('Undo in another text field: the dispatcher leaves it to the field, the native item then undoes the field', () => {
    field.focus()
    const e = press(field, 'z')
    expect(e.defaultPrevented).toBe(false)
    expect(runs['history.undo']).toBe(0)
    // Not remembered: the native item for the same press still runs (it undoes the field).
    expect(runFromNativeMenu('history.undo', manuscript)).toBe(true)
    expect(runs['history.undo']).toBe(1)
  })

  it('Format in another text field: neither the dispatcher nor the native item acts on the manuscript', () => {
    field.focus()
    press(field, 'b')
    expect(runFromNativeMenu('toolbar.bold', manuscript)).toBe(false)
    expect(runs['toolbar.bold']).toBe(0)
    // Non-text commands still work there.
    press(field, 's')
    expect(runs['file.save']).toBe(1)
  })

  it('Review commands (Track Changes, New Comment) do not act from another field or behind a dialog', () => {
    command('review.track', 'Mod-Shift-e', { id: 'review', group: 'tracking', order: 1 })
    field.focus()
    press(field, 'E', { shiftKey: true })
    expect(runFromNativeMenu('review.track', manuscript)).toBe(false)
    expect(runs['review.track']).toBe(0)
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    const button = document.createElement('button')
    dialog.append(button)
    document.body.append(dialog)
    press(button, 'E', { shiftKey: true })
    expect(runs['review.track']).toBe(0)
    // From the manuscript it runs.
    press(manuscript, 'E', { shiftKey: true })
    expect(runs['review.track']).toBe(1)
  })

  it('nativeShortcut keys are left to the webview and not remembered', () => {
    const e = press(manuscript, 'c')
    expect(e.defaultPrevented).toBe(false)
    expect(runs['edit.copy']).toBe(0)
    expect(runFromNativeMenu('edit.copy', manuscript)).toBe(true)
  })

  it('keys inside an open in-app menu do not run commands behind it', () => {
    const item = document.getElementById('mi')!
    item.focus()
    const e = press(item, 'b')
    expect(e.defaultPrevented).toBe(false)
    expect(runs['toolbar.bold']).toBe(0)
    press(item, 's')
    expect(runs['file.save']).toBe(0)
  })
})
