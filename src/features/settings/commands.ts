import { registerCommand } from '@/shared/commands'
import { SETTINGS_CONTROLS, SETTINGS_SHORTCUT } from './controls'
import { openSettings } from './dialog-state'

/**
 * Settings… (Mod-,): the macOS app menu, the end of File elsewhere. Same id and dialog as the
 * gear button (no longer on the toolbar); the registry is the only place Mod-, is bound. Returns unregister.
 */
export function registerSettingsCommands(): () => void {
  return registerCommand({
    id: SETTINGS_CONTROLS.open.id,
    label: 'Settings…',
    description: 'Your name, how pages turn, and what new projects start with. Applies to every project.',
    shortcut: SETTINGS_SHORTCUT,
    menu: { id: 'app', group: 'settings', order: 20 },
    run: openSettings,
  })
}
