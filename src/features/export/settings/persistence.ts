import { registerSideFile, type ProjectSideFile } from '@/features/storage'
import { EXPORT_FILE, parseExportFile, serializeExportFile } from './file'
import { systemLocale } from './presets'
import { getExportFileContent, getExportVersion, isExportTouched, loadExportSettings } from './store'

/**
 * export.json as a project side file (storage slice): read on open, written in one batch with the
 * manuscript on every save, snapshotted by autosave (crash recovery), guarded when damaged or newer.
 * A project without the file opens with the defaults, and the file is created only once the user changes a
 * setting. Unknown keys are written back unchanged.
 */
export const exportSideFile: ProjectSideFile = {
  name: EXPORT_FILE,
  load(data) {
    const parsed = loadExportSettings(data)
    return parsed.newer !== undefined ? { newer: parsed.newer } : undefined
  },
  serialize() {
    return { data: serializeExportFile(getExportFileContent()), empty: !isExportTouched() }
  },
  getVersion: getExportVersion,
  // A recovery snapshot is compared with what is loaded as the settings it means, not as raw JSON.
  comparable(data) {
    return serializeExportFile(parseExportFile(data, systemLocale()))
  },
}

/** Register export.json with the storage slice (once, at app start). Returns unregister. */
export function registerExportSideFile(): () => void {
  return registerSideFile(exportSideFile)
}
