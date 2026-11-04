import { useSyncExternalStore } from 'react'

/** Module state for the two dialogs (one window, one set of dialogs). */
interface DialogState {
  settingsOpen: boolean
  promptOpen: boolean
}

let state: DialogState = { settingsOpen: false, promptOpen: false }
/** Where focus was when Settings opened (the gear, or the manuscript): given back on close. */
let returnFocusTo: HTMLElement | null = null
const listeners = new Set<() => void>()

function update(patch: Partial<DialogState>): void {
  state = { ...state, ...patch }
  listeners.forEach((l) => l())
}

function rememberFocus(): void {
  returnFocusTo = document.activeElement instanceof HTMLElement ? document.activeElement : null
}

function restoreFocus(): void {
  const target = returnFocusTo
  returnFocusTo = null
  // The dialogs are state-driven (no Radix trigger), so Radix has nowhere to return focus to.
  if (target) setTimeout(() => target.isConnected && target.focus(), 0)
}

/** Open the Settings dialog (toolbar gear, Mod-, and the Settings… menu item). */
export function openSettings(): void {
  if (state.settingsOpen) return
  rememberFocus()
  update({ settingsOpen: true })
}

export function closeSettings(): void {
  if (!state.settingsOpen) return
  update({ settingsOpen: false })
  restoreFocus()
}

export function openAuthorPrompt(): void {
  if (!state.promptOpen) rememberFocus()
  update({ promptOpen: true })
}

export function closeAuthorPrompt(): void {
  if (!state.promptOpen) return
  update({ promptOpen: false })
  restoreFocus()
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function isSettingsOpen(): boolean {
  return state.settingsOpen
}

export function useDialogState(): DialogState {
  return useSyncExternalStore(subscribe, () => state, () => state)
}
