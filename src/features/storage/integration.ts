import { useEffect } from 'react'
import { isTauri } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { startAutosave, stopAutosave } from './autosave'
import { exitApp, MENU_EVENTS } from './ipc'
import {
  clearRecoveryData,
  confirmUnsavedChanges,
  hasPendingRecovery,
  loadRecentProjects,
  newProject,
  offerReopenAfterCrash,
  openProject,
  saveProject,
} from './project'
import { getDocumentProvider } from '@/shared/document'
import { detectPlatform, matchesShortcut, type Platform } from '@/shared/ui'

let exitFlow: Promise<boolean> | null = null

/**
 * The one close/quit flow: unsaved-changes prompt, stop autosave, then drop
 * crash-recovery data only if nothing unsaved remains (it was saved, or the
 * user chose "Don't Save", which already deleted it) and no Restore/Discard
 * answer is pending. Resolves true when the app may close. Concurrent calls
 * (e.g. Cmd+Q while the close prompt is open) share one flow.
 */
export function prepareToExit(action: 'closing' | 'quitting'): Promise<boolean> {
  exitFlow ??= (async () => {
    try {
      if (!(await confirmUnsavedChanges(action))) return false
      await stopAutosave()
      if (!hasPendingRecovery() && !getDocumentProvider()?.isDirty()) await clearRecoveryData()
      return true
    } finally {
      exitFlow = null
    }
  })()
  return exitFlow
}

/**
 * Quit requested from the menu / Cmd+Q (or an exit request Rust held): run the exit flow, then exit.
 * macOS Dock > Quit, logoff and Windows shutdown never reach this; crash recovery covers them.
 */
export async function handleQuitRequest(): Promise<void> {
  if (!(await prepareToExit('quitting'))) return
  try {
    await exitApp()
  } catch (e) {
    console.error('Quitting failed:', e)
    startAutosave()
  }
}

/** The Save shortcut (also shown in the File menu and the file.save tooltip). */
export const SAVE_SHORTCUT = 'Mod-s'

/** Mod-S: Cmd+S on macOS, Ctrl+S elsewhere (no Shift/Alt). */
export function isSaveShortcut(
  e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>,
  platform: Platform = detectPlatform(),
): boolean {
  return matchesShortcut(SAVE_SHORTCUT, e, platform)
}

/**
 * Wire storage into the running app: Mod-S, native File menu
 * events, the recent-projects list, and the unsaved-changes prompt on close.
 * Call once from the composition root. Tauri-only parts are skipped in a
 * plain browser (e.g. `pnpm dev`, Playwright).
 */
export function useStorageIntegration(): void {
  useEffect(() => {
    const disposers: (() => void)[] = []

    const onKeyDown = (e: KeyboardEvent) => {
      if (!isSaveShortcut(e)) return
      e.preventDefault()
      void saveProject()
    }
    window.addEventListener('keydown', onKeyDown)
    disposers.push(() => window.removeEventListener('keydown', onKeyDown))
    const stopAutosaveTimer = startAutosave()
    disposers.push(() => void stopAutosaveTimer())

    let disposed = false
    const track = (p: Promise<UnlistenFn>) => {
      p.then((un) => (disposed ? un() : disposers.push(un))).catch((e) =>
        console.warn('Storage event binding failed:', e),
      )
    }

    if (isTauri()) {
      track(listen(MENU_EVENTS.NEW_PROJECT, () => void newProject()))
      track(listen(MENU_EVENTS.OPEN_PROJECT, () => void openProject()))
      track(listen<string>(MENU_EVENTS.OPEN_RECENT, (e) => void openProject(e.payload)))
      track(listen(MENU_EVENTS.SAVE, () => void saveProject()))
      track(listen(MENU_EVENTS.QUIT, () => void handleQuitRequest()))
      const win = getCurrentWindow()
      track(
        win.onCloseRequested(async (event) => {
          event.preventDefault()
          if (!(await prepareToExit('closing'))) return
          try {
            await win.destroy()
          } catch (e) {
            // Still running: keep protecting the user's work.
            console.error('Closing the window failed:', e)
            startAutosave()
          }
        }),
      )
      void loadRecentProjects().then(offerReopenAfterCrash)
    }

    return () => {
      disposed = true
      disposers.forEach((d) => d())
    }
  }, [])
}
