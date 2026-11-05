// Public interface of the "settings" slice (app preferences and the Settings dialog).
// Other slices import ONLY from here.
//
// - <SettingsDialog />: render once in the app. Hosts the Settings dialog and the one-time author
//   question (both portal).
// - <SettingsButton />: toolbar gear (data-control-id `settings.open`); wrap in the editor's ToolbarItem.
// - useSettingsIntegration(): call once at the composition root. Loads preferences.json, writes
//   changes (debounced) and applies the Motion preference.
// - registerSettingsCommands(): Settings… (Mod-,) in the command registry (app menu on macOS, end of
//   File elsewhere). The composition root calls it with the other slices' registrations.
// - openSettings(): the dialog the gear and Settings… open.
// - getAuthor() / useAuthor(): { name, color } to attribute tracked changes and comments to.
// - ensureAuthorName(): the name, asking once (when none is known) the first time it is needed.
// - prefersReducedMotion() / useReducedMotion(): the Motion preference resolved against the OS.
// - SETTINGS_CONTROLS: control ids and names (the tooltips registry derives from them).
// The preference values live in the store (`preferences` slice, @/shared/store); the file is
// documented in docs/project-format.md.
export { SettingsDialog } from './SettingsDialog'
export { SettingsButton } from './SettingsButton'
export type { SettingsButtonProps } from './SettingsButton'
export { useSettingsIntegration } from './integration'
export { registerSettingsCommands } from './commands'
export { openSettings, closeSettings } from './dialog-state'
export { getAuthor, useAuthor, ensureAuthorName } from './author'
export type { Author } from './author'
export { prefersReducedMotion, useReducedMotion } from './motion'
// flushPreferences(): write pending changes now; await it in the quit / window-close path.
export { flushPreferences } from './persistence'
export { SETTINGS_CONTROLS, SETTINGS_SHORTCUT } from './controls'
export type { SettingsControlMeta, SettingsControlKey } from './controls'
