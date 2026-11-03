import { describe, expect, it } from 'vitest'
import { useStore } from './index'

describe('store', () => {
  it('app slice updates colorScheme through its named action', () => {
    useStore.getState().appActions.setColorScheme('dark')
    expect(useStore.getState().app.colorScheme).toBe('dark')
  })
})
