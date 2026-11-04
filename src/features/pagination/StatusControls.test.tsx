import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useStore } from '@/shared/store'
import { TooltipProvider } from '@/shared/ui'
import { PAGINATION_CONTROLS } from './controls'
import { PageIndicator, pageIndicatorText, ZoomControls } from './StatusControls'

afterEach(() => {
  cleanup()
  act(() => {
    useStore.getState().layoutActions.resetLayout()
    useStore.getState().layoutActions.setZoom({ mode: 'fit-spread', percent: 100 })
    useStore.getState().layoutActions.setScale(1)
    useStore.getState().bookActions.resetBook()
  })
})

describe('page indicator', () => {
  it('reads "Pages 12–13 of 384" for a spread and "Page 1 of 384" for one page', () => {
    expect(pageIndicatorText(11, 12, 384)).toBe('Pages 12–13 of 384')
    expect(pageIndicatorText(0, 0, 384)).toBe('Page 1 of 384')
    expect(pageIndicatorText(383, 384, 384)).toBe('Page 384 of 384')
    expect(pageIndicatorText(0, 0, 0)).toBe('')
  })

  it('follows the visible spread in the store', () => {
    render(<PageIndicator />)
    expect(screen.queryByTestId('page-indicator')).toBeNull()
    act(() => {
      const a = useStore.getState().layoutActions
      a.setPages(Array.from({ length: 5 }, (_, i) => ({ index: i, side: i % 2 ? 'verso' : 'recto', from: i, to: i + 1, isBlank: false, startsBlockType: null, chapterIndex: 0 })))
      a.setVisibleSpread({ index: 1, first: 1, last: 2 })
    })
    expect(screen.getByTestId('page-indicator')).toHaveTextContent('Pages 2–3 of 5')
  })
})

describe('zoom controls', () => {
  const renderControls = () =>
    render(
      <TooltipProvider>
        <ZoomControls />
      </TooltipProvider>,
    )

  it('every control has its id and an accessible name', () => {
    renderControls()
    for (const meta of Object.values(PAGINATION_CONTROLS)) {
      const el = document.querySelector(`[data-control-id="${meta.id}"]`)!
      expect(el).not.toBeNull()
      expect(el.getAttribute('aria-label')).toMatch(new RegExp(`^${meta.label}`))
    }
  })

  it('zoom in / out step through the presets; the select picks fit modes and percentages', () => {
    renderControls()
    act(() => useStore.getState().layoutActions.setScale(0.87))
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
    expect(useStore.getState().layout.zoom).toEqual({ mode: 'percent', percent: 100 })
    act(() => useStore.getState().layoutActions.setScale(1))
    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }))
    expect(useStore.getState().layout.zoom).toEqual({ mode: 'percent', percent: 75 })
    const select = screen.getByRole('combobox')
    fireEvent.change(select, { target: { value: 'fit-width' } })
    expect(useStore.getState().layout.zoom.mode).toBe('fit-width')
    fireEvent.change(select, { target: { value: '150' } })
    expect(useStore.getState().layout.zoom).toEqual({ mode: 'percent', percent: 150 })
  })

  it('the spread toggle sets book.view', () => {
    renderControls()
    const toggle = screen.getByRole('button', { name: 'Two-page spread' })
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(toggle)
    expect(useStore.getState().book.view).toBe('single')
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
  })
})
