import { isTauri } from '@tauri-apps/api/core'
import { detectPlatform, type Platform } from '@/shared/ui'

export type MenuBarKind = 'native' | 'in-app'

/**
 * Which menu bar the app shows (decision 4ec247fc): the native global menu bar in the macOS desktop
 * app; the themed in-app menu bar everywhere else (Windows, the web build, and the e2e build, whose
 * Tauri is a fake, so Playwright covers the in-app bar on every engine).
 */
export function menuBarKind(
  env: { tauri: boolean; platform: Platform; mode: string } = {
    tauri: isTauri(),
    platform: detectPlatform(),
    mode: import.meta.env.MODE,
  },
): MenuBarKind {
  return env.tauri && env.platform === 'mac' && env.mode !== 'e2e' ? 'native' : 'in-app'
}
