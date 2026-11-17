import { afterEach, describe, expect, it } from 'vitest'
import { currentAuthor, setCommentAuthorSource } from '@/features/comments'
import { useStore } from '@/shared/store'
import { commentAuthor, UNKNOWN_AUTHOR } from './App'

// The app's author source for comments and tracked changes (storage review #13): a user without a
// name is shown as "Unknown author" and is `anonymous`, so they own no comment message.

function setName(name: string) {
  useStore.setState((s) => ({ preferences: { ...s.preferences, authorName: name } }))
}

afterEach(() => {
  setName('')
  setCommentAuthorSource(null)
})

describe('commentAuthor', () => {
  it('a nameless user is "Unknown author" and anonymous', () => {
    setName('')
    expect(commentAuthor()).toMatchObject({ name: UNKNOWN_AUTHOR, anonymous: true })
    setName('   ')
    expect(commentAuthor()).toMatchObject({ name: UNKNOWN_AUTHOR, anonymous: true })
  })

  it('a named user is not anonymous', () => {
    setName('Ada')
    expect(commentAuthor()).toMatchObject({ name: 'Ada', anonymous: false })
  })

  it('reaches the comments slice, so its ownership rule applies in the app', () => {
    setCommentAuthorSource(commentAuthor)
    setName('')
    expect(currentAuthor()).toMatchObject({ name: UNKNOWN_AUTHOR, anonymous: true })
    setName('Ada')
    expect(currentAuthor().anonymous).toBeFalsy()
  })
})
