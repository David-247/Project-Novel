import { detectPlatform, matchesShortcut, type Platform } from '@/shared/ui'
import { commandGuard, getCommand, getCommands, isCommandEnabled, type Command } from './registry'

/**
 * The keyboard side of the registry: one window listener runs the command whose shortcut was pressed.
 *
 * - Bubble phase, after every app handler: a key the editor's own keymap already handled (Mod-b in
 *   the manuscript, which then calls preventDefault) is left alone, so nothing runs twice.
 * - `nativeShortcut` commands (Cut, Copy, Paste, ...) are never dispatched: the webview does them.
 * - Text commands (Edit history/clipboard, Insert, Format, and any command with guard 'manuscript',
 *   e.g. New Comment) do not reach into the manuscript while
 *   another text field or a modal dialog has focus (Mod-z there undoes the field, not the book), nor
 *   while an open in-app menu has focus. Guard 'modal' (Track Changes, the markup views) only keeps
 *   a command from acting behind a dialog; other commands (Next Comment, Save, ...) run anywhere.
 * - A disabled command leaves the key to the browser.
 *
 * macOS: the native menu's accelerator fires for the same press as the webview's keydown. A press the
 * webview handled (this dispatcher ran it, or an app handler prevented its default) is remembered, and
 * the native menu event for it is dropped (`runFromNativeMenu`). A press the webview declined is not
 * remembered, so the native item still runs it, with the same field guard (history commands do run in
 * text fields there: their `run` undoes the field, since WKWebView gets no OS Undo item any more).
 */
export interface CommandShortcutOptions {
  /** The manuscript's editable root (text commands are allowed there). */
  manuscript: () => HTMLElement | null | undefined
  platform?: Platform
}

/** A native menu event this soon after the matching, handled key press is the same press. */
export const SAME_PRESS_MS = 400

let lastPress: { id: string; at: number } | null = null

/** True when `id`'s shortcut was pressed and handled in the webview just now. */
export function wasJustPressed(id: string, now = performance.now()): boolean {
  return !!lastPress && lastPress.id === id && now - lastPress.at < SAME_PRESS_MS
}

function remember(cmd: Command) {
  lastPress = { id: cmd.id, at: performance.now() }
}

const guardOf = commandGuard

const isHistoryCommand = (cmd: Command) => cmd.menu?.id === 'edit' && cmd.menu.group === 'history'

function isEditableField(el: Element): boolean {
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true
  if (el instanceof HTMLInputElement) return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color'].includes(el.type)
  // isContentEditable, or the attribute (jsdom does not implement isContentEditable).
  return el instanceof HTMLElement && (el.isContentEditable || !!el.closest('[contenteditable]:not([contenteditable="false"])'))
}

/** Focus is inside an open menu of the in-app menu bar. */
function inOpenMenu(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest('[role="menu"], [data-nv-menu-content]')
}

/** Where `cmd` must not act: inside a dialog (both guards), or another text field ('manuscript'). */
function guarded(cmd: Command, target: EventTarget | null, manuscript: HTMLElement | null | undefined): boolean {
  const guard = guardOf(cmd)
  if (guard === 'none' || !(target instanceof Element)) return false
  if (manuscript && (target === manuscript || manuscript.contains(target))) return false
  if (target.closest('[role="dialog"], [role="alertdialog"]')) return true
  return guard === 'manuscript' && isEditableField(target)
}

export function commandForKey(e: KeyboardEvent, platform: Platform): Command | undefined {
  if (e.isComposing || e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta') return undefined
  return getCommands().find((c) => c.shortcut && matchesShortcut(c.shortcut, e, platform))
}

/** Install the shortcut listener on `window`. Returns uninstall. */
export function installCommandShortcuts({ manuscript, platform = detectPlatform() }: CommandShortcutOptions): () => void {
  const onKeyDown = (e: KeyboardEvent) => {
    const cmd = commandForKey(e, platform)
    if (!cmd) return
    if (e.defaultPrevented) {
      // Handled by an app handler (the editor keymap, a panel): the same press, if the menu fires too.
      remember(cmd)
      return
    }
    if (cmd.nativeShortcut) return
    if (inOpenMenu(e.target)) return
    if (guarded(cmd, e.target, manuscript())) return
    if (!isCommandEnabled(cmd)) return
    e.preventDefault()
    remember(cmd)
    cmd.run()
  }
  window.addEventListener('keydown', onKeyDown)
  return () => window.removeEventListener('keydown', onKeyDown)
}

/**
 * A native menu item was chosen (`menu://command`). Dropped when it is the accelerator of a key press
 * the webview already handled; text commands other than Undo/Redo do not act on the manuscript while
 * another text field or a dialog has focus. True when the command ran.
 */
export function runFromNativeMenu(id: string, manuscript: HTMLElement | null | undefined, now = performance.now()): boolean {
  if (wasJustPressed(id, now)) return false
  const cmd = getCommand(id)
  if (!cmd || !isCommandEnabled(cmd)) return false
  if (!isHistoryCommand(cmd) && guarded(cmd, document.activeElement, manuscript)) return false
  cmd.run()
  return true
}

/** Test-only. */
export function __resetKeyboardForTests(): void {
  lastPress = null
}
