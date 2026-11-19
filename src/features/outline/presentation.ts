import { useSyncExternalStore } from 'react'

/**
 * How the pane is presented, apart from the persisted intent (`preferences.navigationPane`, written only
 * by the toggle command and the close button): docked, or floating over the pages in a narrow window;
 * and, in the overlay, dismissed for now (a jump or Escape hid it so the page shows). The dismissal is
 * never persisted: the toggle command clears it, and so does the window widening back to the docked
 * layout, so a narrow-window jump never turns the docked pane off.
 */

/** Below this window width the pane overlays the pages instead of docking beside them. */
export const OVERLAY_MAX_WIDTH = 767
const OVERLAY_QUERY = `(max-width: ${OVERLAY_MAX_WIDTH}px)`

let dismissed = false
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

export function isOverlayLayout(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(OVERLAY_QUERY).matches
}

/** The overlay was dismissed (and the window is still narrow). */
export function isOverlayDismissed(): boolean {
  return dismissed
}

export function setOverlayDismissed(on: boolean): void {
  if (dismissed === on) return
  dismissed = on
  emit()
}

/** Overlay layout changes and dismissal changes. Widening to the docked layout ends a dismissal. */
export function subscribePresentation(cb: () => void): () => void {
  listeners.add(cb)
  installMedia()
  return () => listeners.delete(cb)
}

let mediaSubscribed = false
/** One media listener for all subscribers, installed on the first subscription. */
function installMedia() {
  if (mediaSubscribed || typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
  mediaSubscribed = true
  window.matchMedia(OVERLAY_QUERY).addEventListener('change', () => {
    if (!isOverlayLayout()) dismissed = false
    emit()
  })
}

/** The narrow-window layout and whether the overlay is dismissed, for the pane. */
export function usePresentation(): { overlay: boolean; dismissed: boolean } {
  const overlay = useSyncExternalStore(subscribePresentation, isOverlayLayout, () => false)
  const off = useSyncExternalStore(subscribePresentation, isOverlayDismissed, () => false)
  return { overlay, dismissed: overlay && off }
}
