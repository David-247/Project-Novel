import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { cancelDraft, currentAuthor } from '@/features/comments'
import { currentTrackAuthor } from '@/features/track-changes'
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

  it('lays out the full menu bar: File, Edit, View, Insert, Format, Review, Help', async () => {
    await renderApp()
    const model = buildMenuModel(getCommands(), 'in-app')
    expect(model.map((m) => m.label)).toEqual(['File', 'Edit', 'View', 'Insert', 'Format', 'Review', 'Help'])
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
      'Settings…',
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
    expect(names(model[2].children)).toContain('Comments Panel')
    expect(names(model[3].children)).toEqual(['Chapter Break', 'Page Break', 'Scene Break', '—', 'Footnote', 'Comment'])
    expect(names(model[2].children)).toContain('Markup ▸')
    expect(names(model[5].children)).toEqual(['Track Changes', '—', 'New Comment', '—', 'Next Comment', 'Previous Comment', '—', 'Show Resolved Comments'])
    expect(names(model[6].children)).toEqual(['Keyboard Shortcuts', 'Project Folder Format', '—', 'About Novel'])
  })

  it('opens every menu and submenu of the in-app menu bar; each item has a wired tooltip', async () => {
    await renderApp()
    const bar = screen.getByRole('menubar', { name: 'Menu bar' })
    const titles = Array.from(bar.querySelectorAll<HTMLElement>('[data-control-id^="menu."]'))
    expect(titles.map((t) => t.textContent)).toEqual(['File', 'Edit', 'View', 'Insert', 'Format', 'Review', 'Help'])
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
    // Opens ~20 menus and audits the whole app each time: ~2.5 s locally, over 5 s on a loaded CI runner.
  }, 20_000)

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

  it('track changes commands: Mod-Shift-e is Track Changes, Mod-e is Align Center; state from the store', async () => {
    await renderApp()
    const cmd = (id: string) => getCommands().find((c) => c.id === id)!
    expect(cmd('review.track').shortcut).toBe('Mod-Shift-e')
    expect(cmd('review.track').menu?.id).toBe('review')
    expect(cmd('toolbar.alignCenter').shortcut).toBe('Mod-e')
    expect(getTooltipCopy('toolbar.alignCenter')!.shortcut).toBe('Mod-e')
    expect(cmd('review.track').isChecked!()).toBe(false)
    await waitFor(() => expect(useStore.getState().preferences.loaded).toBe(true))
    act(() => useStore.getState().preferencesActions.load({ authorName: 'Ada Lovelace' }))
    act(() => cmd('review.track').run())
    expect(useStore.getState().book.trackChanges).toBe(true)
    expect(cmd('review.track').isChecked!()).toBe(true)
    expect(currentTrackAuthor()).toEqual({ name: 'Ada Lovelace', color: null })
    act(() => cmd('review.track').run())
    expect(cmd('review.track').isChecked!()).toBe(false)
    for (const v of ['simple', 'none', 'original', 'all'] as const) {
      act(() => cmd(`review.markup.${v}`).run())
      expect(useStore.getState().trackChanges.markupView).toBe(v)
      expect(['all', 'simple', 'none', 'original'].filter((o) => cmd(`review.markup.${o}`).isChecked!())).toEqual([v])
    }
  })

  it('switching Track Changes on with no author name asks the one-time question; tracked changes say "Unknown author" without one', async () => {
    await renderApp()
    await waitFor(() => expect(useStore.getState().preferences.loaded).toBe(true))
    act(() => useStore.getState().preferencesActions.load({ authorName: '' }))
    expect(currentTrackAuthor().name).toBe('Unknown author')
    act(() => getCommands().find((c) => c.id === 'review.track')!.run())
    const field = await screen.findByRole('textbox', { name: 'Your name' })
    fireEvent.change(field, { target: { value: 'Grace Hopper' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }))
    await waitFor(() => expect(currentTrackAuthor().name).toBe('Grace Hopper'))
    // Off and on again: asked once only.
    act(() => getCommands().find((c) => c.id === 'review.track')!.run())
    act(() => getCommands().find((c) => c.id === 'review.track')!.run())
    expect(screen.queryByRole('textbox', { name: 'Your name' })).toBeNull()
    act(() => useStore.getState().bookActions.setTrackChanges(false))
  })

  it('the status bar shows the Track Changes notice and the side-file warning together', async () => {
    await renderApp()
    act(() => {
      useStore.getState().projectActions.setSideFileWarning('comments.json is damaged.')
      useStore.getState().trackChangesActions.setNotice('Track Changes could not record your last edit.')
    })
    const bar = screen.getByRole('contentinfo', { name: 'Status bar' })
    expect(bar.querySelector('[data-testid="side-file-warning"]')).toHaveTextContent('comments.json is damaged.')
    expect(bar.querySelector('[data-testid="track-changes-notice"]')).toHaveTextContent('Track Changes could not record')
    act(() => {
      useStore.getState().projectActions.setSideFileWarning(null)
      useStore.getState().trackChangesActions.setNotice(null)
    })
  })

  it('comment commands: enabled and checked state from the comments slice', async () => {
    await renderApp()
    const cmd = (id: string) => getCommands().find((c) => c.id === id)!
    const comments = useStore.getState().commentsActions
    expect(cmd('comment.new').shortcut).toBe('Mod-Alt-m')
    expect(cmd('comment.new').menu?.id).toBe('review')
    expect(cmd('insert.comment').shortcut).toBeUndefined()
    expect(cmd('comment.new').isEnabled!()).toBe(true)
    expect(cmd('comment.next').isEnabled!()).toBe(false)
    expect(cmd('comment.prev').isEnabled!()).toBe(false)
    act(() => comments.setShowResolved(true))
    expect(cmd('comment.showResolved').isChecked!()).toBe(true)
    act(() => comments.setShowResolved(false))
    expect(cmd('comment.showResolved').isChecked!()).toBe(false)
    const panelOpen = useStore.getState().comments.panelOpen
    expect(cmd('comment.panel').isChecked!()).toBe(panelOpen)
    act(() => cmd('comment.panel').run())
    expect(cmd('comment.panel').isChecked!()).toBe(!panelOpen)
    act(() => cmd('comment.panel').run())
  })

  it('comments are by the Settings author ("Unknown author" without one); New Comment asks for a name first', async () => {
    await renderApp()
    await waitFor(() => expect(useStore.getState().preferences.loaded).toBe(true))
    const prefs = useStore.getState().preferencesActions
    act(() => prefs.load({ authorName: 'Ada Lovelace', authorColor: '#335577' }))
    expect(currentAuthor()).toEqual({ name: 'Ada Lovelace', color: '#335577' })
    act(() => prefs.load({ authorName: '', authorPrompted: true }))
    expect(currentAuthor().name).toBe('Unknown author')

    // No name known and never asked: the one-time question comes before the composer.
    act(() => prefs.load({ authorName: '' }))
    const ed = getEditor()!
    act(() => {
      ed.commands.insertContent('Words to comment on')
      ed.commands.selectAll()
    })
    act(() => getCommands().find((c) => c.id === 'comment.new')!.run())
    const field = await screen.findByRole('textbox', { name: 'Your name' })
    expect(useStore.getState().comments.draft).toBeNull()
    fireEvent.change(field, { target: { value: 'Grace Hopper' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }))
    await waitFor(() => expect(useStore.getState().comments.draft).not.toBeNull())
    expect(currentAuthor().name).toBe('Grace Hopper')
    expect(useStore.getState().preferences.authorPrompted).toBe(true)
    // Asked once: the next New Comment opens the composer straight away.
    act(() => void cancelDraft())
    act(() => getCommands().find((c) => c.id === 'comment.new')!.run())
    expect(useStore.getState().comments.draft).not.toBeNull()
    act(() => void cancelDraft())
  })
})
