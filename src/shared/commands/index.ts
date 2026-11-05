// Shared command registry (Phase 3). Any slice may register commands without importing another
// slice; the menu slice renders them as the in-app menu bar or the native macOS menu, binds their
// shortcuts and lists them in Help > Keyboard Shortcuts. See docs/design.md, "Menus and commands".
//
//   const off = registerCommand({ id: 'toolbar.bold', label: 'Bold', description: 'Make text bold.',
//     shortcut: 'Mod-b', menu: { id: 'format', group: 'marks', order: 10 },
//     isChecked: () => ..., run: () => ... })
//
// - id: reuse the control's data-control-id where a control exists (its tooltip copy then applies).
// - A duplicate id or shortcut, or a missing description, throws in development and tests.
// - Call notifyCommandStateChanged() when something isEnabled/isChecked read changed (debounced).
// - menu.id 'app' is the macOS app menu; elsewhere group 'about' goes to Help, other groups to File.
export {
  registerCommand,
  registerCommands,
  getCommands,
  getCommand,
  useCommands,
  notifyCommandStateChanged,
  subscribeCommands,
  subscribeCommandState,
  useCommandStateVersion,
  runCommand,
  isCommandEnabled,
  shortcutKey,
  commandProblem,
  COMMAND_STATE_DEBOUNCE_MS,
  __resetCommandsForTests,
} from './registry'
export type { Command, MenuId } from './registry'
export {
  buildMenuModel,
  nativeMenuSnapshot,
  toAccelerator,
  submenuControlId,
  menuControlId,
  MENU_LABELS,
  NATIVE_ROLES,
} from './menu-model'
export type { MenuModel, MenuNode, MenuLayout, NativeMenuNode, NativeMenuSnapshot, PredefinedItem } from './menu-model'
export { installCommandShortcuts, wasJustPressed, commandForKey, SAME_PRESS_MS } from './keyboard'
export type { CommandShortcutOptions } from './keyboard'
export { menuBarKind } from './platform'
export type { MenuBarKind } from './platform'
