import { act, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useStore } from '@/shared/store'
import { isSaveShortcut } from './integration'
import { SaveStatusIndicator, saveStatusText } from './SaveStatusIndicator'

const key = (k: Partial<KeyboardEvent>) => ({ key: 's', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...k })

describe('Mod-S', () => {
  it('is Ctrl+S off macOS and Cmd+S on macOS', () => {
    expect(isSaveShortcut(key({ ctrlKey: true }), false)).toBe(true)
    expect(isSaveShortcut(key({ metaKey: true }), false)).toBe(false)
    expect(isSaveShortcut(key({ metaKey: true }), true)).toBe(true)
    expect(isSaveShortcut(key({ ctrlKey: true }), true)).toBe(false)
    expect(isSaveShortcut(key({ ctrlKey: true, key: 'S' }), false)).toBe(true)
    expect(isSaveShortcut(key({ ctrlKey: true, shiftKey: true }), false)).toBe(false)
    expect(isSaveShortcut(key({ ctrlKey: true, key: 'a' }), false)).toBe(false)
  })
})

describe('save status', () => {
  it('describes each state', () => {
    const base = { path: '/p', title: 't', dirty: false, saveStatus: 'idle' as const }
    expect(saveStatusText({ ...base, path: null })).toBe('No project open')
    expect(saveStatusText({ ...base, dirty: true })).toBe('Unsaved changes')
    expect(saveStatusText({ ...base, saveStatus: 'saving' })).toBe('Saving…')
    expect(saveStatusText({ ...base, saveStatus: 'saved' })).toBe('Saved')
    expect(saveStatusText({ ...base, saveStatus: 'error' })).toBe('Save failed')
  })

  it('renders from the store as a polite status', () => {
    useStore.getState().projectActions.projectOpened({ path: '/p', title: 'My Novel' })
    useStore.getState().editorActions.docChanged(false) // editor.dirty is the source of truth
    render(<SaveStatusIndicator />)
    expect(screen.getByRole('status')).toHaveTextContent('My Novel: Unsaved changes')
  })

  it('shows "Opening…" while a project is being opened', () => {
    const { container } = render(<SaveStatusIndicator />)
    const status = () => container.querySelector('[role="status"]')
    act(() => useStore.getState().projectActions.openStarted())
    expect(status()).toHaveTextContent(/^Opening…$/)
    act(() => useStore.getState().projectActions.openFinished())
    expect(status()).not.toHaveTextContent('Opening…')
  })
})
