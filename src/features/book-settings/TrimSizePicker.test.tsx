import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { auditTooltipCoverage, formatCoverageProblems, getTooltipCopy } from '@/features/tooltips'
import { DEFAULT_MARGINS, getTrimSize, TRIM_SIZES } from '@/shared/book'
import { useStore } from '@/shared/store'
import { TooltipProvider } from '@/shared/ui'
import { TrimSizePicker } from './index'

beforeAll(() => {
  // Radix menus use pointer capture / scrollIntoView, which jsdom lacks.
  Element.prototype.hasPointerCapture ??= () => false
  Element.prototype.setPointerCapture ??= () => {}
  Element.prototype.releasePointerCapture ??= () => {}
  Element.prototype.scrollIntoView ??= () => {}
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})

beforeEach(() => useStore.getState().bookActions.resetBook())
afterEach(cleanup)

const book = () => useStore.getState().book
const trigger = () => screen.getByRole('button', { name: /^Trim size:/ })

function renderPicker() {
  return render(
    <TooltipProvider lookup={getTooltipCopy}>
      <TrimSizePicker />
    </TooltipProvider>,
  )
}

/** Open with the keyboard, like a keyboard-only user. */
function openWithKeyboard() {
  act(() => trigger().focus())
  fireEvent.keyDown(trigger(), { key: 'ArrowDown' })
  return screen.getByRole('menu')
}

describe('TrimSizePicker', () => {
  it('shows the current size, is a labelled control with id book.trimSize and a registered tooltip', () => {
    renderPicker()
    expect(trigger()).toHaveAttribute('data-control-id', 'book.trimSize')
    expect(trigger()).toHaveAccessibleName('Trim size: Trade, 5.5 x 8.5 in')
    expect(trigger().getAttribute('aria-describedby')).toBeTruthy()
    expect(getTooltipCopy('book.trimSize')?.title).toBe('Trim size')
    act(() => useStore.getState().bookActions.setTrimSize('uk-a5'))
    expect(trigger()).toHaveTextContent('A5')
    expect(trigger()).toHaveTextContent('148 x 210 mm')
  })

  it('lists every size grouped US and UK/EU, each with a label and its dimensions', () => {
    renderPicker()
    const menu = openWithKeyboard()
    const groups = within(menu).getAllByRole('group', { name: /./ })
    expect(groups.map((g) => g.getAttribute('aria-label'))).toEqual(['US', 'UK/EU'])
    const items = within(menu).getAllByRole('menuitemradio')
    expect(items).toHaveLength(TRIM_SIZES.length)
    for (const t of TRIM_SIZES) {
      const item = items.find((i) => i.getAttribute('data-control-id') === `book.trimSize.${t.id}`)!
      expect(item).toHaveTextContent(t.label)
      expect(item).toHaveTextContent(t.dimensions)
    }
    expect(within(groups[0]).getAllByRole('menuitemradio')).toHaveLength(5)
    expect(within(groups[1]).getAllByRole('menuitemradio')).toHaveLength(4)
    expect(items.find((i) => i.getAttribute('aria-checked') === 'true')).toHaveTextContent('Trade')
  })

  it('is keyboard operable: arrows move, Enter selects, the store is updated and the project is unsaved', async () => {
    renderPicker()
    const menu = openWithKeyboard()
    const items = within(menu).getAllByRole('menuitemradio')
    // Radix focuses the checked / first item on keyboard open; arrow to Large trade (6 x 9) and choose it.
    act(() => items.find((i) => i.getAttribute('aria-checked') === 'true')!.focus())
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
    await waitFor(() => expect(document.activeElement).toHaveTextContent('Large trade'))
    fireEvent.keyDown(document.activeElement!, { key: 'Enter' })
    expect(book()).toMatchObject({ trimSize: 'us-6x9', dirty: true })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(trigger()).toHaveTextContent('Large trade')
  })

  it('Escape closes the menu without changing anything and returns focus to the trigger', async () => {
    renderPicker()
    openWithKeyboard()
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(book()).toMatchObject({ trimSize: 'us-5.5x8.5', dirty: false })
    await waitFor(() => expect(document.activeElement).toBe(trigger()))
  })

  it('opens on pointer press and selects with a click', () => {
    renderPicker()
    fireEvent.pointerDown(trigger(), { button: 0, ctrlKey: false, pointerType: 'mouse' })
    const demy = screen.getByRole('menuitemradio', { name: /Demy/ })
    fireEvent.click(demy)
    expect(book().trimSize).toBe('uk-demy')
  })

  it('items are touch-sized', () => {
    renderPicker()
    openWithKeyboard()
    for (const item of screen.getAllByRole('menuitemradio')) expect(item.className).toContain('min-h-control-lg')
  })

  it('follows the new size default margins only while the margins are still the old size defaults', () => {
    renderPicker()
    const { bookActions } = useStore.getState()
    expect(book().margins).toEqual(DEFAULT_MARGINS)
    openWithKeyboard()
    fireEvent.click(screen.getByRole('menuitemradio', { name: /A5/ }))
    expect(book()).toMatchObject({ trimSize: 'uk-a5', margins: getTrimSize('uk-a5')!.margins })
    act(() => bookActions.setMargins({ top: 10, bottom: 10, inside: 10, outside: 10 }))
    openWithKeyboard()
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Royal/ }))
    expect(book()).toMatchObject({ trimSize: 'uk-royal', margins: { top: 10, bottom: 10, inside: 10, outside: 10 } })
  })

  it('passes the tooltip coverage audit closed and with the menu open', () => {
    const { container } = renderPicker()
    let problems = auditTooltipCoverage(container)
    expect(problems, formatCoverageProblems(problems)).toEqual([])
    openWithKeyboard()
    problems = auditTooltipCoverage(document.body)
    expect(problems, formatCoverageProblems(problems)).toEqual([])
    for (const t of TRIM_SIZES) expect(getTooltipCopy(`book.trimSize.${t.id}`)).toBeDefined()
  })
})
