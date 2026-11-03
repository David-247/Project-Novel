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
 * Block reload / back / forward accelerators for the whole window.
 *
 * Keys are handled in the BUBBLE phase on window, after every app handler, and only if nobody
 * handled them yet (`defaultPrevented`). This must not run in the capture phase: ProseMirror ignores
 * key events that are already default-prevented, so a capture-phase guard would kill editor
 * shortcuts that share a reload combo (Align right is Mod-Shift-r). When the editor handles such a
 * key it prevents the default itself, so the browser reload is still blocked; the same combo
 * anywhere else (or F5 / Mod-r) reaches this listener and is prevented here.
 * Audit (keep in sync): of the app's shortcuts (TOOLBAR / HISTORY / FIND controls, File menu
 * Mod-Shift-n / Mod-o / Mod-s), only Mod-Shift-r overlaps the guarded keys.
 *
 * Mouse back/forward buttons are still prevented in the capture phase (no app uses them).
 * Pass `enabled = false` where reloading is part of the tooling (the Vite dev server).
 */
export function useReloadGuard(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return
    const platform = detectPlatform()
    const onKey = (e: KeyboardEvent) => {
      if (!e.defaultPrevented && isReloadOrNavigationKey(e, platform)) e.preventDefault()
    }
    const onMouse = (e: MouseEvent) => {
      if (isNavigationButton(e)) e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mouseup', onMouse, true)
    window.addEventListener('auxclick', onMouse, true)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mouseup', onMouse, true)
      window.removeEventListener('auxclick', onMouse, true)
    }
  }, [enabled])
}
