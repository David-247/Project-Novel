import { act, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const tauri = vi.hoisted(() => ({
  isTauri: false,
  initial: null as 'light' | 'dark' | null,
  handler: undefined as ((e: { payload: 'light' | 'dark' }) => void) | undefined,
  unlisten: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => tauri.isTauri }))
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    theme: () => Promise.resolve(tauri.initial),
    onThemeChanged: (h: (e: { payload: 'light' | 'dark' }) => void) => {
      tauri.handler = h
      return Promise.resolve(tauri.unlisten)
    },
  }),
}))

import { useStore } from '@/shared/store'
import { useThemeFollow } from './index'

type Listener = () => void
let mqDark = false
const mqListeners = new Set<Listener>()

function Probe() {
  useThemeFollow()
  return null
}

beforeEach(() => {
  mqDark = false
  mqListeners.clear()
  tauri.isTauri = false
  tauri.initial = null
  tauri.handler = undefined
  tauri.unlisten.mockReset()
  window.matchMedia = ((query: string) => ({
    get matches() {
      return mqDark
    },
    media: query,
    addEventListener: (_: string, l: Listener) => mqListeners.add(l),
    removeEventListener: (_: string, l: Listener) => mqListeners.delete(l),
  })) as unknown as typeof window.matchMedia
  delete document.documentElement.dataset.theme
})

afterEach(() => {
  useStore.getState().appActions.setColorScheme('light')
})

describe('useThemeFollow', () => {
  it('sets data-theme from prefers-color-scheme and follows live changes', () => {
    mqDark = true
    render(<Probe />)
    expect(document.documentElement.dataset.theme).toBe('dark')

    act(() => {
      mqDark = false
      mqListeners.forEach((l) => l())
    })
    expect(document.documentElement.dataset.theme).toBe('light')
    expect(useStore.getState().app.colorScheme).toBe('light')
  })

  it('follows the Tauri window theme event when running in Tauri', async () => {
    tauri.isTauri = true
    tauri.initial = 'dark'
    const { unmount } = render(<Probe />)
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('dark'))
    await waitFor(() => expect(tauri.handler).toBeDefined())

    act(() => tauri.handler!({ payload: 'light' }))
    expect(document.documentElement.dataset.theme).toBe('light')
    act(() => tauri.handler!({ payload: 'dark' }))
    expect(document.documentElement.dataset.theme).toBe('dark')

    unmount()
    expect(tauri.unlisten).toHaveBeenCalled()
  })

  it('does not touch Tauri APIs in a plain browser', () => {
    render(<Probe />)
    expect(tauri.handler).toBeUndefined()
    expect(document.documentElement.dataset.theme).toBe('light')
  })
})
