import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  __resetCommandsForTests,
  buildMenuModel,
  COMMAND_STATE_DEBOUNCE_MS,
  getCommands,
  menuBarKind,
  nativeMenuSnapshot,
  notifyCommandStateChanged,
  registerCommand,
  registerCommands,
  runCommand,
  subscribeCommandState,
  toAccelerator,
  useCommands,
  type Command,
  type MenuNode,
} from './index'

const cmd = (id: string, extra: Partial<Command> = {}): Command => ({
  id,
  label: id,
  description: `Does ${id}.`,
  run: () => {},
  ...extra,
})

afterEach(() => {
  __resetCommandsForTests()
  vi.useRealTimers()
})

describe('command registry', () => {
  it('registers, lists and unregisters', () => {
    const off = registerCommand(cmd('a'))
    registerCommand(cmd('b'))
    expect(getCommands().map((c) => c.id)).toEqual(['a', 'b'])
    off()
    expect(getCommands().map((c) => c.id)).toEqual(['b'])
    off() // twice is harmless
    expect(getCommands().map((c) => c.id)).toEqual(['b'])
  })

  it('throws on a duplicate id', () => {
    registerCommand(cmd('a'))
    expect(() => registerCommand(cmd('a'))).toThrow(/duplicate command id "a"/)
  })

  it('throws on a duplicate shortcut, whatever its spelling', () => {
    registerCommand(cmd('a', { shortcut: 'Mod-Shift-z' }))
    expect(() => registerCommand(cmd('b', { shortcut: 'Shift-Mod-Z' }))).toThrow(/already bound to "a"/)
    expect(() => registerCommand(cmd('c', { shortcut: 'Mod-z' }))).not.toThrow()
  })

  it('throws on a command without a description or label', () => {
    expect(() => registerCommand(cmd('a', { description: '' }))).toThrow(/no description/)
    expect(() => registerCommand(cmd('b', { label: ' ' }))).toThrow(/no label/)
  })

  it('registerCommands rolls back when one of them is rejected', () => {
    expect(() => registerCommands([cmd('a'), cmd('a')])).toThrow()
    expect(getCommands()).toEqual([])
  })

  it('runs only enabled commands', () => {
    const run = vi.fn()
    let enabled = false
    registerCommand(cmd('a', { run, isEnabled: () => enabled }))
    expect(runCommand('a')).toBe(false)
    enabled = true
    expect(runCommand('a')).toBe(true)
    expect(run).toHaveBeenCalledTimes(1)
    expect(runCommand('missing')).toBe(false)
  })

  it('useCommands re-renders on registry change', () => {
    const { result } = renderHook(() => useCommands())
    expect(result.current).toEqual([])
    act(() => void registerCommand(cmd('a')))
    expect(result.current.map((c) => c.id)).toEqual(['a'])
  })

  it('debounces state change notifications', () => {
    vi.useFakeTimers()
    const cb = vi.fn()
    const off = subscribeCommandState(cb)
    notifyCommandStateChanged()
    notifyCommandStateChanged()
    vi.advanceTimersByTime(COMMAND_STATE_DEBOUNCE_MS - 1)
    expect(cb).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(cb).toHaveBeenCalledTimes(1)
    off()
  })
})

const labels = (nodes: MenuNode[]): unknown[] =>
  nodes.map((n) =>
    n.kind === 'item' ? n.command.id : n.kind === 'separator' ? '---' : n.kind === 'predefined' ? `os:${n.name}` : { [n.label]: labels(n.children) },
  )

describe('menu model builder', () => {
  const commands = [
    cmd('save', { menu: { id: 'file', group: 'save', order: 10 } }),
    cmd('new', { menu: { id: 'file', group: 'project', order: 1 } }),
    cmd('open', { menu: { id: 'file', group: 'project', order: 2 } }),
    cmd('recent.0', { menu: { id: 'file', group: 'project', order: 3, submenu: 'Open Recent' } }),
    cmd('recent.1', { menu: { id: 'file', group: 'project', order: 4, submenu: 'Open Recent' } }),
    cmd('quit', { menu: { id: 'app', group: 'quit', order: 99 } }),
    cmd('about', { menu: { id: 'app', group: 'about', order: 1 } }),
    cmd('edit.cut', { menu: { id: 'edit', group: 'clipboard', order: 1 } }),
    cmd('shortcuts', { menu: { id: 'help', group: 'help', order: 1 } }),
    cmd('hidden'),
  ]

  it('orders menus, groups (with separators), items and submenus; leaves empty menus out', () => {
    const model = buildMenuModel(commands, 'in-app')
    expect(model.map((m) => m.label)).toEqual(['File', 'Edit', 'Help'])
    expect(labels(model[0].children)).toEqual(['new', 'open', { 'Open Recent': ['recent.0', 'recent.1'] }, '---', 'save', '---', 'quit'])
    // About moves to the end of Help when there is no app menu.
    expect(labels(model[2].children)).toEqual(['shortcuts', '---', 'about'])
    expect(model[0].children[2]).toMatchObject({ kind: 'submenu', id: 'menu.file.open-recent' })
  })

  it('macOS: app menu with the OS items before Quit, OS clipboard items in Edit', () => {
    const model = buildMenuModel(commands, 'mac-native')
    expect(model.map((m) => m.label)).toEqual(['Novel', 'File', 'Edit', 'Help'])
    expect(labels(model[0].children)).toEqual(['about', '---', 'os:services', '---', 'os:hide', 'os:hideOthers', 'os:showAll', '---', 'quit'])
    expect(labels(model[1].children)).toEqual(['new', 'open', { 'Open Recent': ['recent.0', 'recent.1'] }, '---', 'save'])
    expect(labels(model[2].children)).toEqual(['os:cut'])
  })

  it('serializes the native snapshot with accelerators and live enabled / checked state', () => {
    let checked = true
    const snap = () =>
      nativeMenuSnapshot([
        cmd('bold', { shortcut: 'Mod-b', menu: { id: 'format', group: 'm', order: 1 }, isChecked: () => checked }),
        cmd('undo', { menu: { id: 'edit', group: 'h', order: 1 }, isEnabled: () => false }),
      ])
    const menus = snap().menus
    // The app menu always exists on macOS (Services, Hide, ...).
    expect(menus[0]).toMatchObject({ id: 'app', label: 'Novel' })
    expect(menus[0].items.at(-1)).toEqual({ kind: 'predefined', name: 'showAll' })
    expect(menus.slice(1)).toEqual([
      { id: 'edit', label: 'Edit', items: [{ kind: 'item', id: 'undo', label: 'undo', enabled: false }] },
      { id: 'format', label: 'Format', items: [{ kind: 'item', id: 'bold', label: 'bold', enabled: true, checked: true, accelerator: 'CmdOrCtrl+B' }] },
    ])
    checked = false
    expect(snap().menus[2].items[0]).toMatchObject({ checked: false })
  })

  it('converts ProseMirror shortcut specs to Tauri accelerators', () => {
    expect(toAccelerator('Mod-Shift-e')).toBe('CmdOrCtrl+Shift+E')
    expect(toAccelerator('Mod-Alt-0')).toBe('CmdOrCtrl+Alt+0')
    expect(toAccelerator('Mod--')).toBe('CmdOrCtrl+Minus')
    expect(toAccelerator('Mod-=')).toBe('CmdOrCtrl+Equal')
    expect(toAccelerator('Mod-[')).toBe('CmdOrCtrl+BracketLeft')
    expect(toAccelerator('Mod-\\')).toBe('CmdOrCtrl+Backslash')
    expect(toAccelerator('Mod-Shift-Enter')).toBe('CmdOrCtrl+Shift+Enter')
    expect(toAccelerator('Ctrl-Mod-f')).toBe('Ctrl+CmdOrCtrl+F')
    expect(toAccelerator('F11')).toBe('F11')
  })
})

describe('menuBarKind', () => {
  it('is native only in the macOS desktop app', () => {
    expect(menuBarKind({ tauri: true, platform: 'mac', mode: 'production' })).toBe('native')
    expect(menuBarKind({ tauri: true, platform: 'other', mode: 'production' })).toBe('in-app')
    expect(menuBarKind({ tauri: false, platform: 'mac', mode: 'production' })).toBe('in-app')
    expect(menuBarKind({ tauri: true, platform: 'mac', mode: 'e2e' })).toBe('in-app')
  })
})
