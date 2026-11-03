import { describe, expect, it } from 'vitest'
import { useStore } from './index'

describe('store', () => {
  it('app slice updates colorScheme through its named action', () => {
    useStore.getState().appActions.setColorScheme('dark')
    expect(useStore.getState().app.colorScheme).toBe('dark')
  })
})

describe('find slice', () => {
  it('opens with an optional query, bumps focusRequest, and resets results on close', () => {
    const a = useStore.getState().findActions
    const before = useStore.getState().find.focusRequest
    a.openPanel('cat')
    expect(useStore.getState().find).toMatchObject({ open: true, query: 'cat', focusRequest: before + 1 })
    a.openPanel()
    expect(useStore.getState().find).toMatchObject({ query: 'cat', focusRequest: before + 2 })
    a.setResults(5, 2)
    a.setCaseSensitive(true)
    a.setWholeWord(true)
    a.setReplacement('dog')
    expect(useStore.getState().find).toMatchObject({
      matchCount: 5,
      currentIndex: 2,
      caseSensitive: true,
      wholeWord: true,
      replacement: 'dog',
    })
    a.closePanel()
    expect(useStore.getState().find).toMatchObject({ open: false, matchCount: 0, currentIndex: -1, query: 'cat' })
  })
})

describe('layout slice', () => {
  it('publishes pages with a derived pageCount and a bumped version', () => {
    const a = useStore.getState().layoutActions
    const v = useStore.getState().layout.layoutVersion
    a.setPages([
      { index: 0, side: 'recto', from: 0, to: 10, isBlank: false, startsBlockType: 'heading', chapterIndex: 0 },
      { index: 1, side: 'verso', from: 10, to: 20, isBlank: false, startsBlockType: null, chapterIndex: 0 },
    ])
    expect(useStore.getState().layout).toMatchObject({ pageCount: 2, layoutVersion: v + 1 })
  })

  it('keeps state identity when a setter gets the same value', () => {
    const a = useStore.getState().layoutActions
    a.setVisibleSpread({ index: 1, first: 1, last: 2 })
    const before = useStore.getState().layout
    a.setVisibleSpread({ index: 1, first: 1, last: 2 })
    a.setCurrentPage(before.currentPage)
    a.setEffectiveView(before.effectiveView)
    a.setScale(before.scale)
    expect(useStore.getState().layout).toBe(before)
  })

  it('zoom keeps the percentage when only the mode changes; reset keeps zoom', () => {
    const a = useStore.getState().layoutActions
    a.setZoom({ mode: 'percent', percent: 150 })
    a.setZoom({ mode: 'fit-width' })
    expect(useStore.getState().layout.zoom).toEqual({ mode: 'fit-width', percent: 150 })
    a.resetLayout()
    expect(useStore.getState().layout).toMatchObject({ pageCount: 0, pages: [], zoom: { mode: 'fit-width', percent: 150 } })
  })
})
