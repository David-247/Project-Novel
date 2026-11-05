import { useSyncExternalStore } from 'react'
import { detectPlatform, shortcutSignature, type Platform, type ShortcutSpec } from '@/shared/ui'

/**
 * The command registry: every user-facing action of the app with its label, one-line description,
 * shortcut, menu place, live enabled/checked state and the function that runs it. Slices register
 * their commands through their public index; the menu bar (in-app or native), the keyboard
 * dispatcher and the Keyboard Shortcuts sheet all render from here (docs/design.md, "Menus").
 * Nothing here assumes a menu bar exists (tablet ports).
 */
export type MenuId = 'file' | 'edit' | 'view' | 'insert' | 'format' | 'review' | 'help' | 'app'

export interface RibbonPlacement {
  group: string
  order: number
  display?: 'button' | 'menu'
}

export interface Command {
  /** Reuses the `data-control-id` of the matching control where one exists. */
  id: string
  label: string
  /** One line ending in a period; tooltip text comes from the tooltips registry where an entry exists. */
  description: string
  /** ProseMirror syntax, e.g. 'Mod-Shift-e'. The one place a shortcut is declared. */
  shortcut?: ShortcutSpec
  /**
   * The webview handles the shortcut itself (Cut, Copy, Paste, Paste as Plain Text): the registry only
   * shows it, and the keyboard dispatcher leaves the key alone.
   */
  nativeShortcut?: boolean
  /**
   * Place in the menus. `group` items are separated from other groups (groups ordered by their lowest
   * `order`); `submenu` nests the item under a submenu with that label. Menu 'app' is the macOS app
   * menu; elsewhere its items move to Help (group 'about') or the end of File (any other group).
   */
  menu?: { id: MenuId; group: string; order: number; submenu?: string }
  /**
   * Where the command may run from the keyboard and the native menu (default: by menu, see
   * keyboard.ts). 'manuscript': it acts at the manuscript's caret, so not while another text field
   * or a dialog has focus (Insert, Format, Edit history / clipboard, New Comment). 'modal': anywhere
   * but behind a modal dialog (Track Changes, the markup views). 'none': anywhere.
   */
  guard?: 'manuscript' | 'modal' | 'none'
  /**
   * Place in the ribbon (the toolbar): a group id from @/shared/ribbon (e.g. 'review.changes') and an
   * order inside it. `display: 'button'` (default) adds a labelled button to the group; 'menu' only
   * lists the command when the group is collapsed or in the overflow (the group already shows a control
   * for it). See docs/design.md, "Ribbon".
   */
  ribbon?: RibbonPlacement
  isEnabled?: () => boolean
  /** Present on toggles and radio-like items (rendered as checkable). */
  isChecked?: () => boolean
  run: () => void
}

const commands = new Map<string, Command>()
let snapshot: readonly Command[] = []
const listeners = new Set<() => void>()
const stateListeners = new Set<() => void>()
let stateVersion = 0
let stateTimer: ReturnType<typeof setTimeout> | null = null

/** Debounce of notifyCommandStateChanged (native menu refresh). */
export const COMMAND_STATE_DEBOUNCE_MS = 120

const DEV = import.meta.env.DEV

/**
 * Canonical form of a shortcut on `platform` (the keys actually pressed there), so "Shift-Mod-z" and
 * "Mod-Shift-Z" compare equal. Per platform because Mod is Cmd on macOS: there "Ctrl-Mod-f" (Full
 * Screen) and "Mod-f" (Find) are different keys, while elsewhere both would be Ctrl+F.
 */
export function shortcutKey(spec: ShortcutSpec, platform: Platform = detectPlatform()): string {
  return shortcutSignature(spec, platform) // throws on an unknown modifier
}

/** Why `cmd` cannot be registered next to `existing`, or null. */
export function commandProblem(cmd: Command, existing: Iterable<Command>, platform: Platform = detectPlatform()): string | null {
  if (!cmd.id) return 'a command needs an id'
  if (!cmd.label?.trim()) return `command "${cmd.id}" has no label`
  if (!cmd.description?.trim()) return `command "${cmd.id}" has no description`
  if (cmd.description.includes('\n')) return `command "${cmd.id}": the description must be one line`
  const key = cmd.shortcut ? shortcutKey(cmd.shortcut, platform) : null
  for (const other of existing) {
    if (other.id === cmd.id) return `duplicate command id "${cmd.id}"`
    if (key && other.shortcut && shortcutKey(other.shortcut, platform) === key) {
      return `shortcut ${cmd.shortcut} of "${cmd.id}" is already bound to "${other.id}"`
    }
  }
  return null
}

function emit() {
  snapshot = [...commands.values()]
  listeners.forEach((l) => l())
}

/**
 * Add a command; returns its unregister function. A duplicate id, a duplicate shortcut or a missing
 * description throws in development (and tests); in production the command is skipped with an error.
 */
export function registerCommand(cmd: Command): () => void {
  const problem = commandProblem(cmd, commands.values())
  if (problem) {
    if (DEV) throw new Error(`registerCommand: ${problem}`)
    console.error(`registerCommand: ${problem}`)
    return () => {}
  }
  commands.set(cmd.id, cmd)
  emit()
  return () => {
    if (commands.get(cmd.id) !== cmd) return
    commands.delete(cmd.id)
    emit()
  }
}

/** Register several commands; one unregister for all. */
export function registerCommands(list: readonly Command[]): () => void {
  const offs: (() => void)[] = []
  try {
    for (const c of list) offs.push(registerCommand(c))
  } catch (e) {
    offs.forEach((off) => off())
    throw e
  }
  return () => offs.forEach((off) => off())
}

/** Every registered command, in registration order (a new array only when the registry changed). */
export function getCommands(): Command[] {
  return snapshot as Command[]
}

export function getCommand(id: string): Command | undefined {
  return commands.get(id)
}

/** The command's guard: its own, else 'manuscript' for text commands (Insert, Format, Edit history / clipboard). */
export function commandGuard(cmd: Command): 'manuscript' | 'modal' | 'none' {
  if (cmd.guard) return cmd.guard
  const m = cmd.menu
  if (!m) return 'none'
  const text = m.id === 'insert' || m.id === 'format' || (m.id === 'edit' && (m.group === 'history' || m.group === 'clipboard'))
  return text ? 'manuscript' : 'none'
}

/**
 * A gate over every command (menus, native menu, shortcuts, runCommand): while one is set, a command
 * it refuses is disabled. A mode that replaces the manuscript view registers one (the re-write view:
 * Find, New Comment, page navigation ... make no sense there). One gate at a time.
 */
let gate: ((cmd: Command) => boolean) | null = null
export function setCommandGate(fn: ((cmd: Command) => boolean) | null): () => void {
  gate = fn
  notifyCommandStateChanged()
  return () => {
    if (gate !== fn) return
    gate = null
    notifyCommandStateChanged()
  }
}

/**
 * Does the gate (if one is set) let `cmd` run? For a slice's own input handling that does what a
 * command does without going through it (Book mode's wheel / desk / key page turns).
 */
export function commandGateAllows(cmd: Command): boolean {
  try {
    return !gate || gate(cmd)
  } catch {
    return false
  }
}

export function isCommandEnabled(cmd: Command): boolean {
  try {
    if (gate && !gate(cmd)) return false
    return cmd.isEnabled ? cmd.isEnabled() : true
  } catch {
    return false
  }
}

/** Run a command by id if it exists and is enabled. True when it ran. */
export function runCommand(id: string): boolean {
  const cmd = commands.get(id)
  if (!cmd || !isCommandEnabled(cmd)) return false
  cmd.run()
  return true
}

/** Registry changes (commands added or removed). Returns unsubscribe. */
export function subscribeCommands(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

/** React: the registered commands; re-renders on registry change. */
export function useCommands(): Command[] {
  return useSyncExternalStore(subscribeCommands, getCommands, getCommands) as Command[]
}

/**
 * Something that enabled/checked state reads changed (selection, history, a store value). Debounced:
 * subscribers (the native menu, an open menu) refresh at most once per COMMAND_STATE_DEBOUNCE_MS.
 */
export function notifyCommandStateChanged(): void {
  if (stateTimer !== null) clearTimeout(stateTimer)
  stateTimer = setTimeout(() => {
    stateTimer = null
    stateVersion++
    stateListeners.forEach((l) => l())
  }, COMMAND_STATE_DEBOUNCE_MS)
}

/** Debounced state changes. Returns unsubscribe. */
export function subscribeCommandState(cb: () => void): () => void {
  stateListeners.add(cb)
  return () => stateListeners.delete(cb)
}

const getStateVersion = () => stateVersion

/** React: a number that changes after notifyCommandStateChanged (re-render to read fresh state). */
export function useCommandStateVersion(): number {
  return useSyncExternalStore(subscribeCommandState, getStateVersion, getStateVersion)
}

/** Test-only: empty the registry. */
export function __resetCommandsForTests(): void {
  commands.clear()
  if (stateTimer !== null) clearTimeout(stateTimer)
  stateTimer = null
  emit()
}
