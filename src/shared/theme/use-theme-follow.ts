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
    // The initial theme() read is async; if a newer value arrives first (a Tauri theme event or a
    // media-query change in the store), that one wins and the stale initial read is dropped.
    let superseded = false
    const unsubStore = useStore.subscribe((s, prev) => {
      if (s.app.colorScheme !== prev.app.colorScheme) superseded = true
    })
    win
      .theme()
      .then((t) => {
        if (!disposed && !superseded && t) set(t)
      })
      .catch(() => {})
      .finally(() => unsubStore())
    win
      .onThemeChanged(({ payload }) => {
        superseded = true
        set(payload)
      })
      .then((fn) => {
        if (disposed) fn()
        else unlisten = fn
      })
      .catch(() => {})
    return () => {
      disposed = true
      unsubStore()
      unlisten?.()
    }
  }, [])

  const scheme = useStore((s) => s.app.colorScheme)
  useLayoutEffect(() => {
    applyThemeAttribute(scheme)
  }, [scheme])
}
