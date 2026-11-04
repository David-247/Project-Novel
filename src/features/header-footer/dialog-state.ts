import { useSyncExternalStore } from 'react'

/** Which header/footer dialog is open. Module state: one window, one set of dialogs. */
export type HFDialog = 'settings' | 'details' | null

let open: HFDialog = null
/** Where focus was when the dialogs opened (the toolbar button, or the manuscript): given back on close. */
let returnFocusTo: HTMLElement | null = null
const listeners = new Set<() => void>()

export function openHeaderFooterDialog(which: Exclude<HFDialog, null> = 'settings'): void {
  if (open === null) returnFocusTo = document.activeElement instanceof HTMLElement ? document.activeElement : null
  open = which
  listeners.forEach((l) => l())
}

export function closeHeaderFooterDialog(): void {
  open = null
  listeners.forEach((l) => l())
  // The dialogs are state-driven (no Radix trigger), so Radix has nowhere to return focus to.
  const target = returnFocusTo
  returnFocusTo = null
  if (target) setTimeout(() => target.isConnected && target.focus(), 0)
}

export function useOpenDialog(): HFDialog {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => open,
    () => open,
  )
}
