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
