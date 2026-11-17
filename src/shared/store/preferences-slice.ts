import { defaultPreferenceValues, type PreferenceValues, type Preferences } from './preferences-file'
import type { SliceCreator } from './types'

export type { Preferences, PreferenceValues, PageNavigation, ReduceMotion } from './preferences-file'

/**
 * App preferences (Phase 3): per-user settings kept in the app config dir, not in a project. The
 * slice only holds state; src/features/settings loads it at startup and writes changes (debounced).
 */
export interface PreferencesSlice {
  preferences: Preferences
  preferencesActions: {
    /** Change one preference. */
    set: <K extends keyof PreferenceValues>(key: K, value: PreferenceValues[K]) => void
    /** Back to the defaults (the author name returns to the OS-derived one). Unknown keys are kept. */
    reset: () => void
    /** Replace everything with what was read from the file at startup, and mark the slice loaded. */
    load: (prefs: Partial<PreferenceValues> & { extra?: Record<string, unknown> }) => void
  }
}

/** The OS-derived author name (set once at startup by the loader), used by `reset`. */
let systemAuthorName = ''

export function setSystemAuthorName(name: string): void {
  systemAuthorName = name
}

export const createPreferencesSlice: SliceCreator<PreferencesSlice> = (set) => ({
  preferences: { ...defaultPreferenceValues(), extra: {}, loaded: false },
  preferencesActions: {
    set: (key, value) => set((s) => ({ preferences: { ...s.preferences, [key]: value } })),
    reset: () =>
      set((s) => ({
        preferences: {
          ...defaultPreferenceValues(systemAuthorName),
          // The author question was already asked; resetting does not ask it again.
          authorPrompted: s.preferences.authorPrompted,
          extra: s.preferences.extra,
          loaded: s.preferences.loaded,
        },
      })),
    load: ({ extra, ...values }) =>
      set(() => ({
        preferences: { ...defaultPreferenceValues(), ...values, extra: extra ?? {}, loaded: true },
      })),
  },
})
