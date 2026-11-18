import { useSyncExternalStore } from 'react'
import { getCurrentProjectMeta, sideFileChanged } from '@/features/storage'
import { MAX_EXPORT_FOLDERS, useStore } from '@/shared/store'
import { defaultManuscriptSettings, applyPreset, systemLocale } from './presets'
import type { ExportFileContent, ParsedExportFile } from './file'
import { parseExportFile, readSettings } from './file'
import type { ContactOverride, ManuscriptSettings, PresetId } from './types'
import { CONTACT_FIELDS, CONTACT_MAX } from './types'

/**
 * The open project's export settings (module state, not the shared store: only this slice and its
 * consumers read it). persistence.ts connects it to export.json. A project without the file holds the
 * defaults and creates the file only when the user changes something (`touched`).
 */
interface State {
  settings: ManuscriptSettings
  contact: ContactOverride
}

let state: State = { settings: defaultManuscriptSettings(), contact: {} }
let extra: Record<string, unknown> = {}
let settingsExtra: Record<string, unknown> = {}
/** The user changed something (or the file exists): there is something worth a file. */
let touched = false
/** Bumps on every change the user makes (not on load); storage's guard for a damaged / newer file. */
let version = 0
const listeners = new Set<() => void>()

const emit = () => listeners.forEach((l) => l())
const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}

/** The project's manuscript settings (the same object until they change). */
export const getManuscriptSettings = (): ManuscriptSettings => state.settings

/** The project's contact override (only the fields set for this project). */
export const getContactOverride = (): ContactOverride => state.contact

export const useManuscriptSettings = (): ManuscriptSettings => useSyncExternalStore(subscribe, getManuscriptSettings)
export const useContactOverride = (): ContactOverride => useSyncExternalStore(subscribe, getContactOverride)

function commit(candidate: State): void {
  // What is saved is what reopens: run the settings through the reader (clamps, falls back).
  const next: State = { ...candidate, settings: readSettings(candidate.settings as unknown as Record<string, unknown>, candidate.settings.paper).settings }
  if (JSON.stringify(next) === JSON.stringify(state)) return
  state = next
  touched = true
  version++
  emit()
  sideFileChanged()
}

/** Change some settings (a shallow patch; nested groups are replaced whole). */
export function updateManuscriptSettings(patch: Partial<ManuscriptSettings>): void {
  commit({ ...state, settings: { ...state.settings, ...patch } })
}

/** Apply a preset's look (font, italics, sentence spacing); the writer's other choices stay. */
export function setPreset(id: PresetId): void {
  commit({ ...state, settings: applyPreset(state.settings, id) })
}

/**
 * Set this project's contact override. A field set to '' (or whitespace) is removed, so the app
 * profile applies to it again. Contact details reach the project folder only through this call.
 */
export function setContactOverride(patch: ContactOverride): void {
  const next: ContactOverride = { ...state.contact }
  for (const k of CONTACT_FIELDS) {
    if (!(k in patch)) continue
    const v = (patch[k] ?? '').trim().slice(0, CONTACT_MAX[k])
    if (v === '') delete next[k]
    else next[k] = v
  }
  commit({ ...state, contact: next })
}

/**
 * The folder of the last export of the open project, or null. Kept in the app's preferences.json by project
 * id (machine-local), never in the project folder: reading or setting it is not a change of the project (no
 * unsaved state, no autosave, no export.json write).
 */
export function getLastOutputFolder(): string | null {
  const id = getCurrentProjectMeta()?.id
  return id ? (useStore.getState().preferences.exportFolders[id] ?? null) : null
}

/** Reactive `getLastOutputFolder()`. */
export function useLastOutputFolder(): string | null {
  const folders = useStore((s) => s.preferences.exportFolders)
  const id = getCurrentProjectMeta()?.id
  return id ? (folders[id] ?? null) : null
}

/** Remember the folder of the last export of the open project (null forgets it). No-op without an open project. */
export function setLastOutputFolder(folder: string | null): void {
  const id = getCurrentProjectMeta()?.id
  if (!id) return
  const current = useStore.getState().preferences.exportFolders
  if ((current[id] ?? null) === (folder?.trim() || null)) return
  const next = { ...current }
  delete next[id]
  if (folder?.trim()) next[id] = folder.trim()
  const kept = Object.fromEntries(Object.entries(next).slice(-MAX_EXPORT_FOLDERS))
  useStore.getState().preferencesActions.set('exportFolders', kept)
}

/** Storage opened a project: its export.json parsed (null: none, or a damaged one), or reset. */
export function loadExportSettings(data: unknown | null): ParsedExportFile {
  const parsed = parseExportFile(data, systemLocale())
  state = { settings: parsed.settings, contact: parsed.contact }
  extra = parsed.extra
  settingsExtra = parsed.settingsExtra ?? {}
  touched = data !== null && typeof data === 'object'
  emit()
  return parsed
}

export function getExportFileContent(): ExportFileContent {
  return { settings: state.settings, contact: state.contact, extra, settingsExtra }
}

export const isExportTouched = (): boolean => touched

export const getExportVersion = (): number => version

/** Test-only. */
export function __resetExportSettingsForTests(): void {
  state = { settings: defaultManuscriptSettings(), contact: {} }
  extra = {}
  settingsExtra = {}
  touched = false
  version = 0
  emit()
}
