// Public interface of the "menu" slice (Phase 3): the menus, rendered from the shared command
// registry (@/shared/commands). Other slices import ONLY from here.
//
// - useAppMenus(): mount once at the composition root. Binds every registry shortcut (one window
//   listener), registers the menu slice's commands (Help > Keyboard Shortcuts / Project Folder
//   Format / About Novel, Edit > Go to Page…, View > Full Screen) and keeps the native macOS menu in
//   step (menu_set; items come back as `menu://command`).
// - <AppMenuBar />: the in-app menu bar (Windows, web, e2e); nothing where the menu is native.
// - <MenuDialogs />: the slice's dialogs (portals); render once.
// - MENU_DIALOG_CONTROLS: control ids of those dialogs, for the tooltips registry.
export { useAppMenus, AppMenuBar, MenuDialogs } from './AppMenus'
export { MenuBar } from './MenuBar'
export { MENU_DIALOG_CONTROLS } from './MenuDialogs'
export { menuCommands, registerMenuCommands } from './commands'
export { startNativeMenu, MENU_COMMAND_EVENT } from './native'
