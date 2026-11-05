import { getActiveEditor } from '@/features/editor'

/**
 * Where keyboard focus was before the menu bar (or a Help dialog) took it, so it can be given back:
 * the manuscript (with its selection) or another control. Tracked for the whole document.
 */
let lastOutside: HTMLElement | null = null
let installed = false

const MENU_SELECTOR = '[data-nv-menubar], [data-nv-menu-content]'

export function trackFocusOutsideMenus(): () => void {
  if (installed) return () => {}
  installed = true
  const onFocusIn = (e: FocusEvent) => {
    const t = e.target
    if (t instanceof HTMLElement && !t.closest(MENU_SELECTOR) && !t.closest('[role="dialog"]')) lastOutside = t
  }
  document.addEventListener('focusin', onFocusIn, true)
  return () => {
    installed = false
    document.removeEventListener('focusin', onFocusIn, true)
  }
}

/**
 * Make the manuscript read a selection change it has not picked up yet (ProseMirror reads the DOM
 * selection on the async `selectionchange`): call while it still has focus, just before the menu bar
 * takes it, so the selection given back later is the one the user made.
 */
export function syncEditorSelection(): void {
  const view = getActiveEditor()?.view as unknown as { domObserver?: { flush(): void }; hasFocus(): boolean } | undefined
  if (view?.hasFocus()) view.domObserver?.flush()
}

/**
 * Give focus back to where it was, or to the manuscript. The manuscript is focused through its view,
 * which puts its selection back exactly (a plain DOM focus could briefly put the caret elsewhere).
 */
export function restoreFocus(): void {
  const ed = getActiveEditor()
  const target = lastOutside
  if (target && target.isConnected && target !== document.body) {
    if (ed && (target === ed.view.dom || ed.view.dom.contains(target))) ed.view.focus()
    else target.focus()
    return
  }
  ed?.view.focus()
}
