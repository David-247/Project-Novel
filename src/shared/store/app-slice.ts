import type { SliceCreator } from './types'

export type ColorScheme = 'light' | 'dark'

export interface AppSlice {
  app: {
    colorScheme: ColorScheme
  }
  /** Named actions: the only way to change `app` state. */
  appActions: {
    setColorScheme: (scheme: ColorScheme) => void
  }
}

export function detectColorScheme(): ColorScheme {
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }
  return 'light'
}

export const createAppSlice: SliceCreator<AppSlice> = (set) => ({
  app: { colorScheme: detectColorScheme() },
  appActions: {
    setColorScheme: (scheme) => set((s) => ({ app: { ...s.app, colorScheme: scheme } })),
  },
})
