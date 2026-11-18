import { notifyCommandStateChanged, registerCommands } from '@/shared/commands'
import { useStore } from '@/shared/store'
import { canExportAgain, exportAgain, openWizard } from './controller'
import { EXPORT_COMMAND_IDS } from './controls'

/** File > Export > Manuscript… */
export const EXPORT_MANUSCRIPT_SHORTCUT = 'Mod-Shift-x'
/** File > Export > Export Manuscript Again */
export const EXPORT_AGAIN_SHORTCUT = 'Mod-Alt-Shift-x'

/**
 * File > Export (Word's File > Export): Manuscript… opens the wizard, Export Manuscript Again repeats the
 * last export. Both also sit in the ribbon's Layout > Export group. Returns unregister.
 */
export function registerExportCommands(): () => void {
  const off = registerCommands([
    {
      id: EXPORT_COMMAND_IDS.manuscript,
      label: 'Manuscript…',
      description: 'Export a Word file and a PDF in standard manuscript format, step by step, with checks.',
      shortcut: EXPORT_MANUSCRIPT_SHORTCUT,
      menu: { id: 'file', group: 'export', order: 30, submenu: 'Export' },
      ribbon: { group: 'layout.export', order: 10 },
      guard: 'modal',
      run: () => openWizard(),
    },
    {
      id: EXPORT_COMMAND_IDS.again,
      label: 'Export Manuscript Again',
      description: 'Export once more with the same settings to the same files, replacing them after you confirm.',
      shortcut: EXPORT_AGAIN_SHORTCUT,
      menu: { id: 'file', group: 'export', order: 31, submenu: 'Export' },
      ribbon: { group: 'layout.export', order: 20 },
      guard: 'modal',
      isEnabled: canExportAgain,
      run: () => void exportAgain(),
    },
  ])
  // Enabled state follows the project (its last export folder) and the export folders.
  const unsubscribe = useStore.subscribe((s, prev) => {
    if (s.project.path !== prev.project.path || s.preferences.exportFolders !== prev.preferences.exportFolders) notifyCommandStateChanged()
  })
  return () => {
    unsubscribe()
    off()
  }
}
