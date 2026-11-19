import type { KeyboardEvent as ReactKeyboardEvent } from 'react'

const TAB_STOPS = 'a[href], button, input, select, textarea, [tabindex]'

/** The Tab stops of `root` in DOM order (no positive tabindex is used): enabled, visible, not tabindex -1, one per radio group. */
function tabStops(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(TAB_STOPS)).filter((el) => {
    if ((el as HTMLButtonElement).disabled || el.tabIndex < 0) return false
    if (typeof el.checkVisibility === 'function' ? !el.checkVisibility() : el.closest('[hidden]')) return false
    const input = el as HTMLInputElement
    return !(el.tagName === 'INPUT' && input.type === 'radio' && !input.checked && input.name !== '')
  })
}

/**
 * Option+Tab (Alt+Tab), Safari's and WKWebView's "every control" Tab when "Keyboard navigation" is
 * off: a modal's focus trap (Radix FocusScope) only loops a plain Tab, so at the last control
 * Option+Tab would stop. Loop it the same way: past the last stop to the first, Shift before the
 * first to the last. Returns true when it moved the focus. The shared Dialog (and the export wizard)
 * call it from their content's keydown.
 *
 * Forward, the dialog itself (tabindex -1, before its first stop) takes the focus and the browser's
 * own Option+Tab then moves it on to the first stop, so the move is a keyboard one and shows the focus
 * ring (in macOS WebKit a focus moved by script after a modified key is not :focus-visible); where the
 * browser does not move it on (Chromium), the target is focused right after. Backward, or with a root
 * that cannot take the focus, the target is focused asking for the ring.
 */
export function loopOptionTab(e: KeyboardEvent | ReactKeyboardEvent, root: HTMLElement | null): boolean {
  if (e.key !== 'Tab' || !e.altKey || e.ctrlKey || e.metaKey || !root) return false
  // A key from a dialog opened over this one bubbles here through the React tree (portals): not ours.
  if (e.target instanceof Node && !root.contains(e.target)) return false
  const stops = tabStops(root)
  if (!stops.length) return false
  const at = stops.indexOf(document.activeElement as HTMLElement)
  const target = e.shiftKey ? (at <= 0 ? stops[stops.length - 1] : null) : at === stops.length - 1 || at < 0 ? stops[0] : null
  if (!target) return false
  if (!e.shiftKey && root.hasAttribute('tabindex') && root.tabIndex < 0) {
    root.focus({ preventScroll: true })
    // A browser whose Option+Tab does not move the focus (Chromium) leaves it on the dialog: finish the move.
    setTimeout(() => {
      if (document.activeElement === root) target.focus({ focusVisible: true } as FocusOptions)
    }, 0)
    return true
  }
  e.preventDefault()
  target.focus({ focusVisible: true } as FocusOptions)
  return true
}
