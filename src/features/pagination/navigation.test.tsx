import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { __resetCommandsForTests, getCommand, isCommandEnabled, runCommand } from '@/shared/commands'
import { useStore } from '@/shared/store'
import { TooltipProvider } from '@/shared/ui'
import { registerPaginationCommands } from './commands'
import { PAGINATION_CONTROLS as C } from './controls'
import { setNavigator, spreadEdges, type Navigator } from './navigation'
import { placePages, rowCountFor } from './placement'
import { resolvePageGeometry } from './geometry'
import { TurnControls } from './TurnControls'

const fakeNav = (): Navigator & { [k: string]: ReturnType<typeof vi.fn> } =>
  ({ goToPage: vi.fn(() => true), turn: vi.fn(() => true), edge: vi.fn(() => true), reveal: vi.fn(() => true) }) as never

const pages = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ index: i, side: i % 2 ? ('verso' as const) : ('recto' as const), from: i, to: i + 1, isBlank: false, startsBlockType: null, chapterIndex: 0 }))

afterEach(() => {
  cleanup()
  setNavigator(null)
  __resetCommandsForTests()
  act(() => {
    useStore.getState().layoutActions.resetLayout()
    useStore.getState().preferencesActions.set('pageNavigation', 'book')
  })
})

describe('rowCountFor', () => {
  it('matches placePages for both views', () => {
    const g = resolvePageGeometry(useStore.getState().book.trimSize, useStore.getState().book.margins)
    for (const n of [0, 1, 2, 3, 4, 5, 10, 11])
      for (const v of ['spread', 'single'] as const) expect(rowCountFor(n, v)).toBe(placePages(n, g, v).rowCount)
  })
})

describe('spreadEdges', () => {
  it('flags the first and last spread', () => {
    expect(spreadEdges(0, 3)).toEqual({ atFirst: true, atLast: false })
    expect(spreadEdges(2, 3)).toEqual({ atFirst: false, atLast: true })
    expect(spreadEdges(0, 1)).toEqual({ atFirst: true, atLast: true })
  })
})

describe('TurnControls', () => {
  const renderAt = (row: number, rowCount: number) =>
    render(
      <TooltipProvider>
        <TurnControls row={row} rowCount={rowCount} />
      </TooltipProvider>,
    )

  it('has ids, names and turns; at an edge it is marked disabled but stays focusable', () => {
    const nav = fakeNav()
    setNavigator(nav)
    const { container } = renderAt(0, 3)
    const prev = container.querySelector<HTMLButtonElement>(`[data-control-id="${C.previousSpread.id}"]`)!
    const next = container.querySelector<HTMLButtonElement>(`[data-control-id="${C.nextSpread.id}"]`)!
    expect(prev.getAttribute('aria-label')).toBe(C.previousSpread.label)
    expect(next.getAttribute('aria-label')).toBe(C.nextSpread.label)
    expect(prev.getAttribute('aria-disabled')).toBe('true')
    expect(prev.disabled).toBe(false)
    expect(next.hasAttribute('aria-disabled')).toBe(false)
    fireEvent.click(prev)
    expect(nav.turn).not.toHaveBeenCalled()
    fireEvent.click(next)
    expect(nav.turn).toHaveBeenCalledWith(1)
    fireEvent.keyDown(next, { key: 'End' })
    expect(nav.edge).toHaveBeenCalledWith(1)
  })
})

describe('navigation commands', () => {
  it('Book / Continuous Scroll is a radio pair on the preference', () => {
    registerPaginationCommands()
    expect(useStore.getState().preferences.pageNavigation).toBe('book')
    expect(getCommand('view.bookNavigation')!.isChecked!()).toBe(true)
    runCommand('view.scrollNavigation')
    expect(useStore.getState().preferences.pageNavigation).toBe('scroll')
    expect(getCommand('view.bookNavigation')!.isChecked!()).toBe(false)
    expect(getCommand('view.scrollNavigation')!.isChecked!()).toBe(true)
  })

  it('spread commands are disabled at the first / last spread and call the navigator', () => {
    registerPaginationCommands()
    const nav = fakeNav()
    setNavigator(nav)
    const a = useStore.getState().layoutActions
    act(() => {
      a.setPages(pages(5)) // spread rows: [0] [1,2] [3,4]
      a.setEffectiveView('spread')
      a.setVisibleSpread({ index: 0, first: 0, last: 0 })
    })
    const enabled = (id: string) => isCommandEnabled(getCommand(id)!)
    expect(enabled(C.previousSpread.id)).toBe(false)
    expect(enabled('view.firstSpread')).toBe(false)
    expect(enabled(C.nextSpread.id)).toBe(true)
    runCommand(C.nextSpread.id)
    expect(nav.turn).toHaveBeenCalledWith(1)
    act(() => a.setVisibleSpread({ index: 2, first: 3, last: 4 }))
    expect(enabled(C.nextSpread.id)).toBe(false)
    expect(enabled('view.lastSpread')).toBe(false)
    runCommand('view.firstSpread')
    expect(nav.edge).toHaveBeenCalledWith(-1)
    // No registry shortcut: the view's own PageUp / PageDown handling is the only binding.
    for (const id of [C.previousSpread.id, C.nextSpread.id, 'view.firstSpread', 'view.lastSpread']) expect(getCommand(id)!.shortcut).toBeUndefined()
  })
})
