import { useSyncExternalStore } from 'react'

/** Which header/footer dialog is open. Module state: one window, one set of dialogs. */
export type HFDialog = 'settings' | 'details' | null

let open: HFDialog = null
const listeners = new Set<() => void>()

export function openHeaderFooterDialog(which: Exclude<HFDialog, null> = 'settings'): void {
  open = which
  listeners.forEach((l) => l())
}

export function closeHeaderFooterDialog(): void {
  open = null
  listeners.forEach((l) => l())
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
