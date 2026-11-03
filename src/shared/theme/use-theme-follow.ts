import { useEffect, useLayoutEffect } from 'react'
import { isTauri } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { useColorSchemeSync, useStore } from '@/shared/store'
import type { ColorScheme } from '@/shared/store'

/** Writes the theme onto <html> so every token in tokens.css switches at once. */
export function applyThemeAttribute(scheme: ColorScheme, root: HTMLElement = document.documentElement): void {
  root.dataset.theme = scheme
}

/**
 * Follow the OS light/dark setting live. Call once at the composition root.
 *
 * Sources (both feed the same store action, `appActions.setColorScheme`):
 *  - `prefers-color-scheme` media query (via useColorSchemeSync; works in browser and webview)
 *  - Tauri's window theme (`getCurrentWindow().theme()` + `onThemeChanged`), so the app follows
 *    the OS even where the webview is slow to update its media query.
 * Sink: `app.colorScheme` -> `data-theme` on <html> (applied before paint).
 */
export function useThemeFollow(): void {
  useColorSchemeSync()

  useEffect(() => {
    if (!isTauri()) return
    const win = getCurrentWindow()
    const set = useStore.getState().appActions.setColorScheme
    let unlisten: (() => void) | undefined
    let disposed = false
    win
      .theme()
      .then((t) => {
        if (!disposed && t) set(t)
      })
      .catch(() => {})
    win
      .onThemeChanged(({ payload }) => set(payload))
      .then((fn) => {
        if (disposed) fn()
        else unlisten = fn
      })
      .catch(() => {})
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])

  const scheme = useStore((s) => s.app.colorScheme)
  useLayoutEffect(() => {
    applyThemeAttribute(scheme)
  }, [scheme])
}
