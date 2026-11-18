import { getEditor } from '@/features/editor'
import { notifyCommandStateChanged, registerCommands, type Command } from '@/shared/commands'
import { useStore } from '@/shared/store'
import { OUTLINE_CONTROLS as C } from './controls'

/** The pane's root element carries this attribute (focus checks, tests). */
export const PANE_ATTR = 'data-navigation-pane'

const prefs = () => useStore.getState().preferences
const setOpen = (open: boolean) => useStore.getState().preferencesActions.set('navigationPane', open)

/** Focus requests from the commands, taken by the mounted pane (it may mount after the request). */
let focusRequested = false
const focusListeners = new Set<() => void>()

/** The pane asks whether it should take the focus now (and clears the request). */
export function takeFocusRequest(): boolean {
  const r = focusRequested
  focusRequested = false
  return r
}

export function onFocusRequest(cb: () => void): () => void {
  focusListeners.add(cb)
  return () => focusListeners.delete(cb)
}

function requestFocus() {
  focusRequested = true
  focusListeners.forEach((l) => l())
}

const focusInPane = () => !!document.activeElement?.closest(`[${PANE_ATTR}]`)

/** Back to the manuscript (Escape in the tree, closing the pane from inside it). */
export function focusManuscript(): void {
  const ed = getEditor()
  if (ed && !ed.isDestroyed) ed.view.focus()
}

/** Show the pane and move the focus to its current heading (Word's Ctrl+F puts the focus in its pane). */
export function openNavigationPane(): void {
  if (!prefs().navigationPane) setOpen(true)
  requestFocus()
}

/** Hide the pane; the focus returns to the manuscript when it was in the pane. */
export function closeNavigationPane(): void {
  const inside = focusInPane()
  if (prefs().navigationPane) setOpen(false)
  if (inside) focusManuscript()
}

/** View ▸ Navigation Pane. */
export function toggleNavigationPane(): void {
  if (prefs().navigationPane) closeNavigationPane()
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
      isChecked: () => prefs().navigationPane,
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
  return () => {
    offStore()
    off()
  }
}
