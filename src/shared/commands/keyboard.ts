import { detectPlatform, matchesShortcut, type Platform } from '@/shared/ui'
import { getCommand, getCommands, isCommandEnabled, type Command } from './registry'

/**
 * The keyboard side of the registry: one window listener runs the command whose shortcut was pressed.
 *
 * - Bubble phase, after every app handler: a key the editor's own keymap already handled (Mod-b in
 *   the manuscript, which then calls preventDefault) is left alone, so nothing runs twice.
 * - `nativeShortcut` commands (Cut, Copy, Paste, ...) are never dispatched: the webview does them.
 * - Text commands (Edit history/clipboard, Insert, Format, Review) do not reach into the manuscript while
 *   another text field or a modal dialog has focus (Mod-z there undoes the field, not the book), nor
 *   while an open in-app menu has focus.
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

function isTextCommand(cmd: Command): boolean {
  const m = cmd.menu
  if (!m) return false
  // Review (comments, Track Changes) acts on the manuscript too: never behind a dialog or from another field.
  return m.id === 'insert' || m.id === 'format' || m.id === 'review' || (m.id === 'edit' && (m.group === 'history' || m.group === 'clipboard'))
}

const isHistoryCommand = (cmd: Command) => cmd.menu?.id === 'edit' && cmd.menu.group === 'history'

function isEditableField(el: Element): boolean {
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true
  if (el instanceof HTMLInputElement) return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color'].includes(el.type)
  return el instanceof HTMLElement && el.isContentEditable
}

/** Focus is inside an open menu of the in-app menu bar. */
function inOpenMenu(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest('[role="menu"], [data-nv-menu-content]')
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
    if (isTextCommand(cmd) && guarded(e.target, manuscript())) return
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
  if (isTextCommand(cmd) && !isHistoryCommand(cmd) && guarded(document.activeElement, manuscript)) return false
  cmd.run()
  return true
}

/** Test-only. */
export function __resetKeyboardForTests(): void {
  lastPress = null
}
