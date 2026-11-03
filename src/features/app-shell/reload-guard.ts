import { useEffect } from 'react'
import { detectPlatform, type Platform } from '@/shared/ui'

type KeyLike = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>

/**
 * True for browser accelerators that reload the webview or navigate it back/forward. In the
 * desktop app either one throws the page away, and with it up to 30 s of typing since the last
 * crash-recovery snapshot:
 * - reload: F5, Ctrl+F5, Shift+F5, Mod+R, Mod+Shift+R, BrowserRefresh;
 * - history: Alt+Left / Alt+Right (not on macOS, where Option+Arrow moves by word), BrowserBack,
 *   BrowserForward.
 */
export function isReloadOrNavigationKey(e: KeyLike, platform: Platform = detectPlatform()): boolean {
  const mod = platform === 'mac' ? e.metaKey : e.ctrlKey
  switch (e.key) {
    case 'F5':
    case 'BrowserRefresh':
    case 'BrowserBack':
    case 'BrowserForward':
      return true
    case 'r':
    case 'R':
      return mod && !e.altKey
    case 'ArrowLeft':
    case 'ArrowRight':
      return platform !== 'mac' && e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey
    default:
      return false
  }
}

/** Mouse back/forward side buttons (MouseEvent.button 3 and 4) also navigate the webview. */
const isNavigationButton = (e: MouseEvent) => e.button === 3 || e.button === 4

/**
 * Block reload / back / forward accelerators for the whole window (capture phase, before any
 * other handler; the key is only default-prevented, never stopped, so app shortcuts still see it).
 * Pass `enabled = false` where reloading is part of the tooling (the Vite dev server).
 */
export function useReloadGuard(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return
    const platform = detectPlatform()
    const onKey = (e: KeyboardEvent) => {
      if (isReloadOrNavigationKey(e, platform)) e.preventDefault()
    }
    const onMouse = (e: MouseEvent) => {
      if (isNavigationButton(e)) e.preventDefault()
    }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('mouseup', onMouse, true)
    window.addEventListener('auxclick', onMouse, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('mouseup', onMouse, true)
      window.removeEventListener('auxclick', onMouse, true)
    }
  }, [enabled])
}
