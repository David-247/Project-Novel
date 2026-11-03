import { useEffect } from 'react'
import { isTauri } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { MENU_EVENTS } from './ipc'
import {
  confirmUnsavedChanges,
  loadRecentProjects,
  newProject,
  openProject,
  saveProject,
  trackDirtyState,
} from './project'

export function isMacPlatform(): boolean {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
}

/** Mod-S: Cmd+S on macOS, Ctrl+S elsewhere (no Shift/Alt). */
export function isSaveShortcut(e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>, mac = isMacPlatform()): boolean {
  const mod = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
  return mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 's'
}

/**
 * Wire storage into the running app: dirty tracking, Mod-S, native File menu
 * events, the recent-projects list, and the unsaved-changes prompt on close.
 * Call once from the composition root. Tauri-only parts are skipped in a
 * plain browser (e.g. `pnpm dev`, Playwright).
 */
export function useStorageIntegration(): void {
  useEffect(() => {
    const disposers: (() => void)[] = [trackDirtyState()]

    const onKeyDown = (e: KeyboardEvent) => {
      if (!isSaveShortcut(e)) return
      e.preventDefault()
      void saveProject()
    }
    window.addEventListener('keydown', onKeyDown)
    disposers.push(() => window.removeEventListener('keydown', onKeyDown))

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
      const win = getCurrentWindow()
      track(
        win.onCloseRequested(async (event) => {
          event.preventDefault()
          if (await confirmUnsavedChanges('closing')) await win.destroy()
        }),
      )
      void loadRecentProjects()
    }

    return () => {
      disposed = true
      disposers.forEach((d) => d())
    }
  }, [])
}
