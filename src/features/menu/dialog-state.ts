import { useSyncExternalStore } from 'react'

/** The menu slice's dialogs (Help and Go to Page). Module state: one window, one dialog at a time. */
export type MenuDialog = 'shortcuts' | 'about' | 'projectFormat' | 'goToPage' | null

let open: MenuDialog = null
let opens = 0
const listeners = new Set<() => void>()

/** Increments every time a dialog opens (a key that gives each opening fresh state). */
export function menuDialogOpenCount(): number {
  return opens
}

export function openMenuDialog(which: MenuDialog): void {
  if (which && which !== open) opens++
  open = which
  listeners.forEach((l) => l())
}

export function getMenuDialog(): MenuDialog {
  return open
}

export function useMenuDialog(): MenuDialog {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => open,
    () => open,
  )
}
