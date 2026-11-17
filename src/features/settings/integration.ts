import { useEffect } from 'react'
import { loadPreferences, startPreferencesWriter } from './persistence'
import { useReduceMotionAttribute } from './motion'

/**
 * Wire preferences into the running app: load preferences.json at startup, write changes
 * (debounced) and apply the Motion preference. Call once from the composition root. Mod-, (Settings…)
 * is bound by the command registry (registerSettingsCommands), not here.
 */
export function useSettingsIntegration(): void {
  useReduceMotionAttribute()
  useEffect(() => {
    const stopWriter = startPreferencesWriter()
    void loadPreferences()
    return stopWriter
  }, [])
}
