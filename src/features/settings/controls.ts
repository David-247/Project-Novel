/**
 * Stable identities and names of the Settings controls (toolbar gear, dialog, author prompt).
 * The tooltips registry derives titles from here and adds descriptions.
 */
export interface SettingsControlMeta {
  id: string
  label: string
  shortcut?: string | readonly string[]
}

export const SETTINGS_SHORTCUT = 'Mod-,'

export const SETTINGS_CONTROLS = {
  open: { id: 'settings.open', label: 'Settings', shortcut: SETTINGS_SHORTCUT },
  authorName: { id: 'settings.authorName', label: 'Author name' },
  authorColor: { id: 'settings.authorColor', label: 'Author colour' },
  authorColorAuto: { id: 'settings.authorColorAuto', label: 'Automatic colour' },
  pageNavigation: { id: 'settings.pageNavigation', label: 'Page navigation' },
  reduceMotion: { id: 'settings.reduceMotion', label: 'Motion' },
  defaultPaper: { id: 'settings.defaultPaper', label: 'Paper' },
  defaultTrimSize: { id: 'settings.defaultTrimSize', label: 'Trim size' },
  reset: { id: 'settings.reset', label: 'Reset to defaults' },
  done: { id: 'settings.done', label: 'Done' },
  promptName: { id: 'settings.prompt.name', label: 'Your name' },
  promptSave: { id: 'settings.prompt.save', label: 'Save name' },
  promptSkip: { id: 'settings.prompt.skip', label: 'Not now' },
} as const satisfies Record<string, SettingsControlMeta>

export type SettingsControlKey = keyof typeof SETTINGS_CONTROLS
