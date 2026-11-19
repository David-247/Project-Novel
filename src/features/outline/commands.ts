import { getEditor } from '@/features/editor'
import { notifyCommandStateChanged, registerCommands, type Command } from '@/shared/commands'
import { useStore } from '@/shared/store'
import { OUTLINE_CONTROLS as C } from './controls'
import { isOverlayDismissed, isOverlayLayout, setOverlayDismissed, subscribePresentation } from './presentation'

/** The pane's root element carries this attribute (focus checks, tests). */
export const PANE_ATTR = 'data-navigation-pane'

const prefs = () => useStore.getState().preferences
const setOpen = (open: boolean) => useStore.getState().preferencesActions.set('navigationPane', open)

/** Focus requests from the commands, taken by the mounted pane (it may mount after the request). */
let focusRequested = false
/** Where the focus was when it was requested: if the user moved it since, the request lapses. */
let focusedAtRequest: Element | null = null
/** A click or a key outside the pane since the request (see cancelOnInteraction). */
let interacted = false
const focusListeners = new Set<() => void>()

/**
 * The pane asks whether it should take the focus now (and clears the request). Null: no. Otherwise a
 * check to call right before focusing (the pane focuses a frame later): false when the user clicked or
 * typed outside the pane in between.
 */
export function takeFocusRequest(): (() => boolean) | null {
  const r = focusRequested
  focusRequested = false
  const moved = document.activeElement !== focusedAtRequest && document.activeElement !== document.body
  focusedAtRequest = null
  if (!r || moved || interacted) {
    stopWatchingInteraction()
    return null
  }
  return () => {
    const ok = !interacted
    stopWatchingInteraction()
    return ok
  }
}

/**
 * A click or a key outside the pane after the request also cancels it, even when the focus stays
 * where it was (a click into the manuscript that already had the focus): otherwise a tree built later
 * (an idle callback) would take the focus from text being typed (seen on macOS CI: the typed words went
 * to the tree's type-ahead). The listeners are added after the current event, so the shortcut's own
 * keydown does not count.
 */
let stopWatchingInteraction: () => void = () => {}
function cancelOnInteraction() {
  stopWatchingInteraction()
  interacted = false
  const cancel = (e: Event) => {
    if (e.target instanceof Element && e.target.closest(`[${PANE_ATTR}]`)) return
    interacted = true
    focusRequested = false
  }
  const timer = setTimeout(() => {
    window.addEventListener('pointerdown', cancel, true)
    window.addEventListener('keydown', cancel, true)
  }, 0)
  stopWatchingInteraction = () => {
    clearTimeout(timer)
    window.removeEventListener('pointerdown', cancel, true)
    window.removeEventListener('keydown', cancel, true)
    stopWatchingInteraction = () => {}
  }
}

export function onFocusRequest(cb: () => void): () => void {
  focusListeners.add(cb)
  return () => focusListeners.delete(cb)
}

function requestFocus() {
  focusRequested = true
  focusedAtRequest = document.activeElement
  cancelOnInteraction()
  focusListeners.forEach((l) => l())
}

const focusInPane = () => !!document.activeElement?.closest(`[${PANE_ATTR}]`)

/** Back to the manuscript (Escape in the tree, closing the pane from inside it). */
export function focusManuscript(): void {
  const ed = getEditor()
  if (ed && !ed.isDestroyed) ed.view.focus()
}

/** The pane is on screen: open, and not dismissed in the narrow-window overlay. */
export const isNavigationPaneShown = () => prefs().navigationPane && !(isOverlayLayout() && isOverlayDismissed())

/** Show the pane and move the focus to its current heading (Word's Ctrl+F puts the focus in its pane). */
export function openNavigationPane(): void {
  setOverlayDismissed(false)
  if (!prefs().navigationPane) setOpen(true)
  requestFocus()
}

/** Hide the pane (the close button, the toggle): persisted. The focus returns to the manuscript when it was in the pane. */
export function closeNavigationPane(): void {
  const inside = focusInPane()
  setOverlayDismissed(false)
  if (prefs().navigationPane) setOpen(false)
  if (inside) focusManuscript()
}

/**
 * Hide the narrow-window overlay for now (a jump, Escape) so the page shows, without changing the
 * persisted open state: the docked pane is back when the window widens, and after a restart.
 */
export function dismissOverlay(): void {
  const inside = focusInPane()
  setOverlayDismissed(true)
  if (inside) focusManuscript()
}

/** View ▸ Navigation Pane: shows a dismissed overlay again, else toggles the persisted open state. */
export function toggleNavigationPane(): void {
  if (isNavigationPaneShown()) closeNavigationPane()
  else openNavigationPane()
}

/** The pane's commands for the registry (View menu, ribbon View ▸ Show, the shortcut). */
export function outlineCommands(): Command[] {
  return [
    {
      id: C.toggle.id,
      label: C.toggle.label,
      description: C.toggle.description,
      shortcut: C.toggle.shortcut,
      // Before Comments Panel (40), as Word's Show group lists Navigation Pane.
      menu: { id: 'view', group: 'panels', order: 30 },
      ribbon: { group: 'view.show', order: 10 },
      guard: 'modal',
      isChecked: isNavigationPaneShown,
      run: toggleNavigationPane,
    },
  ]
}

/** Register the navigation pane commands and keep their checked state fresh. Returns unregister. */
export function registerOutlineCommands(): () => void {
  const off = registerCommands(outlineCommands())
  const offStore = useStore.subscribe((s, p) => {
    if (s.preferences.navigationPane !== p.preferences.navigationPane) notifyCommandStateChanged()
  })
  const offPresentation = subscribePresentation(notifyCommandStateChanged)
  return () => {
    offPresentation()
    offStore()
    off()
  }
}
