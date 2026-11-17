import { afterEach, describe, expect, it } from 'vitest'
import { __resetCommandsForTests } from '@/shared/commands'
import { useStore } from '@/shared/store'
import { currentTrackAuthor, setTrackChangesAuthorSource } from './extension'
import { registerTrackChangesCommands } from './menu-commands'

// Integration hooks of the slice: the author source fallback and the notice's lifetime.

afterEach(() => {
  setTrackChangesAuthorSource(null)
  __resetCommandsForTests()
  useStore.getState().trackChangesActions.setNotice(null)
  useStore.getState().projectActions.projectClosed()
})

describe('track changes integration hooks', () => {
  it('the author is "Unknown author" with no source, an empty name, or a source that throws', () => {
    expect(currentTrackAuthor().name).toBe('Unknown author')
    setTrackChangesAuthorSource(() => ({ name: '  ' }))
    expect(currentTrackAuthor().name).toBe('Unknown author')
    setTrackChangesAuthorSource(() => {
      throw new Error('boom')
    })
    expect(currentTrackAuthor().name).toBe('Unknown author')
    setTrackChangesAuthorSource(() => ({ name: 'Ada', color: '#123456' }))
    expect(currentTrackAuthor()).toEqual({ name: 'Ada', color: '#123456' })
  })

  it('the status-bar notice is dropped when a project is opened or closed', () => {
    const off = registerTrackChangesCommands()
    const s = () => useStore.getState()
    s().trackChangesActions.setNotice('Track Changes could not record your last edit.')
    s().projectActions.projectOpened({ path: '/books/a', title: 'A' })
    expect(s().trackChanges.notice).toBeNull()
    s().trackChangesActions.setNotice('Track Changes could not record your last edit.')
    s().projectActions.projectClosed()
    expect(s().trackChanges.notice).toBeNull()
    off()
  })
})
