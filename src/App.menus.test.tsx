import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { getEditor, setDocJSON } from '@/features/editor'
import { auditTooltipCoverage, formatCoverageProblems, getTooltipCopy, TOOLTIP_REGISTRY } from '@/features/tooltips'
import { buildMenuModel, getCommands, shortcutKey, type MenuNode } from '@/shared/commands'
import { useStore } from '@/shared/store'
import { shortcutList } from '@/shared/ui'
import { App } from './App'

// The whole app as the web build: every slice's commands registered, the in-app menu bar rendered.

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
  cleanup()
  setDocJSON({ type: 'doc', content: [{ type: 'paragraph' }] })
})

async function renderApp() {
  render(<App />)
  await waitFor(() => expect(getEditor()).not.toBeNull())
  await waitFor(() => expect(getCommands().length).toBeGreaterThan(50))
}

describe('app commands (one registry for menus, shortcuts and tooltips)', () => {
  it('every command has a one-line description of at most 100 characters, and no shortcut is bound twice', async () => {
    await renderApp()
    const seen = new Map<string, string>()
    for (const c of getCommands()) {
      expect(c.description, c.id).toMatch(/^[^\n]+\.$/)
      expect(c.description.length, c.id).toBeLessThanOrEqual(100)
      if (!c.shortcut) continue
      const key = shortcutKey(c.shortcut)
      expect(seen.get(key), `${c.shortcut} on ${c.id}`).toBeUndefined()
      seen.set(key, c.id)
    }
    expect(seen.size).toBeGreaterThan(20)
  })

  it('a command and the tooltip of its control show the same shortcut', async () => {
    await renderApp()
    for (const c of getCommands()) {
      if (!Object.prototype.hasOwnProperty.call(TOOLTIP_REGISTRY, c.id)) continue
      const tooltipKeys = shortcutList(getTooltipCopy(c.id)!.shortcut)
      if (c.shortcut) expect(tooltipKeys[0], c.id).toBe(c.shortcut)
      else expect(tooltipKeys, c.id).toEqual([])
    }
  })

  it('lays out the full menu bar: File, Edit, View, Insert, Format, Help (Review once it has items)', async () => {
    await renderApp()
    const model = buildMenuModel(getCommands(), 'in-app')
    expect(model.map((m) => m.label)).toEqual(['File', 'Edit', 'View', 'Insert', 'Format', 'Help'])
    const names = (nodes: MenuNode[]): string[] =>
      nodes.flatMap((n) => (n.kind === 'item' ? [n.command.label] : n.kind === 'submenu' ? [`${n.label} ▸`] : n.kind === 'separator' ? ['—'] : []))
    expect(names(model[0].children)).toEqual([
      'New Project…',
      'Open Project…',
      'Open Recent ▸',
      'Close Project',
      '—',
      'Save',
      'Save a Copy…',
      '—',
      'Book Details…',
      'Page Setup ▸',
      '—',
      'Quit Novel',
    ])
    expect(names(model[1].children)).toEqual([
      'Undo',
      'Redo',
      '—',
      'Cut',
      'Copy',
      'Paste',
      'Paste as Plain Text',
      'Select All',
      '—',
      'Find…',
      'Replace…',
      '—',
      'Go to Page…',
    ])
    expect(names(model[3].children)).toEqual(['Chapter Break', 'Page Break', 'Scene Break', '—', 'Footnote'])
    expect(names(model[5].children)).toEqual(['Keyboard Shortcuts', 'Project Folder Format', '—', 'About Novel'])
  })

  it('opens every menu and submenu of the in-app menu bar; each item has a wired tooltip', async () => {
    await renderApp()
    const bar = screen.getByRole('menubar', { name: 'Menu bar' })
    const titles = Array.from(bar.querySelectorAll<HTMLElement>('[data-control-id^="menu."]'))
    expect(titles.map((t) => t.textContent)).toEqual(['File', 'Edit', 'View', 'Insert', 'Format', 'Help'])
    let items = 0
    for (const title of titles) {
      act(() => title.focus())
      act(() => void fireEvent.keyDown(title, { key: 'ArrowDown' }))
      const menu = await screen.findByRole('menu')
      // Open each submenu in turn (ArrowRight on its title).
      for (const sub of Array.from(menu.querySelectorAll<HTMLElement>('[aria-haspopup="menu"]'))) {
        act(() => sub.focus())
        act(() => void fireEvent.keyDown(sub, { key: 'ArrowRight' }))
        await waitFor(() => expect(screen.getAllByRole('menu').length).toBeGreaterThan(1))
        items += document.querySelectorAll('[role="menu"] [data-control-id]').length
        const problems = auditTooltipCoverage(document.body)
        expect(problems, formatCoverageProblems(problems)).toEqual([])
        act(() => void fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' }))
      }
      items += menu.querySelectorAll('[data-control-id]').length
      const problems = auditTooltipCoverage(document.body)
      expect(problems, formatCoverageProblems(problems)).toEqual([])
      act(() => void fireEvent.keyDown(document.activeElement!, { key: 'Escape' }))
      await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    }
    expect(items).toBeGreaterThan(50)
  })

  it('checked and enabled state is live: Bold in bold text, the current paper, Undo with history', async () => {
    await renderApp()
    const cmd = (id: string) => getCommands().find((c) => c.id === id)!
    const ed = getEditor()!
    expect(cmd('history.undo').isEnabled!()).toBe(false)
    act(() => {
      ed.commands.insertContent('Some words')
      ed.commands.selectAll()
      ed.commands.toggleBold()
    })
    expect(cmd('toolbar.bold').isChecked!()).toBe(true)
    expect(cmd('history.undo').isEnabled!()).toBe(true)
    act(() => useStore.getState().bookActions.setSurface('dark'))
    expect(cmd('book.surface.dark').isChecked!()).toBe(true)
    expect(cmd('book.surface.book').isChecked!()).toBe(false)
    act(() => useStore.getState().bookActions.setSurface('auto'))
  })
})
