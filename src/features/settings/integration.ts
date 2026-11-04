import { useEffect } from 'react'
import { matchesShortcut } from '@/shared/ui'
import { SETTINGS_SHORTCUT } from './controls'
import { openSettings } from './dialog-state'
import { loadPreferences, startPreferencesWriter } from './persistence'
import { useReduceMotionAttribute } from './motion'

/**
 * Wire preferences into the running app: load preferences.json at startup, write changes
 * (debounced), open Settings on Mod-, (anywhere in the window), and apply the Motion preference.
 * Call once from the composition root.
 */
export function useSettingsIntegration(): void {
  useReduceMotionAttribute()
  useEffect(() => {
    const stopWriter = startPreferencesWriter()
    void loadPreferences()
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !matchesShortcut(SETTINGS_SHORTCUT, e)) return
      e.preventDefault()
      openSettings()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      stopWriter()
    }
  }, [])
}
