import { detectPlatform, matchesShortcut, type Platform } from '@/shared/ui'
import { getCommands, isCommandEnabled, type Command } from './registry'

/**
 * The keyboard side of the registry: one window listener runs the command whose shortcut was pressed.
 *
 * - Bubble phase, after every app handler: a key the editor's own keymap already handled (Mod-b in
 *   the manuscript, which then calls preventDefault) is left alone, so nothing runs twice.
 * - `nativeShortcut` commands (Cut, Copy, Paste, ...) are never dispatched: the webview does them.
 * - Text commands (Edit history/clipboard, Insert, Format) do not reach into the manuscript while
 *   another text field or a modal dialog has focus (Mod-z there undoes the field, not the book).
 * - A disabled command leaves the key to the browser.
 *
 * The capture-phase half remembers which command a key press matched, so the native macOS menu,
 * whose accelerator fires for the same press, does not run it a second time (wasJustPressed).
 */
export interface CommandShortcutOptions {
  /** The manuscript's editable root (text commands are allowed there). */
  manuscript: () => HTMLElement | null | undefined
  platform?: Platform
}

/** A native menu event this soon after the matching key press is the same press. */
export const SAME_PRESS_MS = 400

let lastPress: { id: string; at: number } | null = null

/** True when `id`'s shortcut was pressed in the webview just now (the native menu fired for it too). */
export function wasJustPressed(id: string, now = performance.now()): boolean {
  return !!lastPress && lastPress.id === id && now - lastPress.at < SAME_PRESS_MS
}

function isTextCommand(cmd: Command): boolean {
  const m = cmd.menu
  if (!m) return false
  return m.id === 'insert' || m.id === 'format' || (m.id === 'edit' && (m.group === 'history' || m.group === 'clipboard'))
}

function isEditableField(el: Element): boolean {
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true
  if (el instanceof HTMLInputElement) return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color'].includes(el.type)
  return el instanceof HTMLElement && el.isContentEditable
}

/** Where a text command must not act: another text field, or anything inside a modal dialog. */
function guarded(target: EventTarget | null, manuscript: HTMLElement | null | undefined): boolean {
  if (!(target instanceof Element)) return false
  if (manuscript && (target === manuscript || manuscript.contains(target))) return false
  if (target.closest('[role="dialog"], [role="alertdialog"]')) return true
  return isEditableField(target)
}

export function commandForKey(e: KeyboardEvent, platform: Platform): Command | undefined {
  if (e.isComposing || e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta') return undefined
  return getCommands().find((c) => c.shortcut && matchesShortcut(c.shortcut, e, platform))
}

/** Install the shortcut listeners on `window`. Returns uninstall. */
export function installCommandShortcuts({ manuscript, platform = detectPlatform() }: CommandShortcutOptions): () => void {
  const onCapture = (e: KeyboardEvent) => {
    const cmd = commandForKey(e, platform)
    if (cmd) lastPress = { id: cmd.id, at: performance.now() }
  }
  const onBubble = (e: KeyboardEvent) => {
    if (e.defaultPrevented) return
    const cmd = commandForKey(e, platform)
    if (!cmd || cmd.nativeShortcut) return
    if (isTextCommand(cmd) && guarded(e.target, manuscript())) return
    if (!isCommandEnabled(cmd)) return
    e.preventDefault()
    cmd.run()
  }
  window.addEventListener('keydown', onCapture, true)
  window.addEventListener('keydown', onBubble)
  return () => {
    window.removeEventListener('keydown', onCapture, true)
    window.removeEventListener('keydown', onBubble)
  }
}
