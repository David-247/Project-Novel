import { isTauri } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { notifyCommandStateChanged, registerCommands, type Command } from '@/shared/commands'
import { useStore } from '@/shared/store'
import { detectPlatform } from '@/shared/ui'
import { openMenuDialog } from './dialog-state'

let fullScreen = false

/** View > Full Screen: the window (desktop app) or the page (web build). */
async function toggleFullScreen(): Promise<void> {
  try {
    if (isTauri()) {
      const win = getCurrentWindow()
      const next = !(await win.isFullscreen())
      await win.setFullscreen(next)
      fullScreen = next
    } else if (document.fullscreenElement) {
      await document.exitFullscreen()
      fullScreen = false
    } else {
      await document.documentElement.requestFullscreen()
      fullScreen = true
    }
  } catch (e) {
    console.warn('Full screen is not available:', e)
  }
  notifyCommandStateChanged()
}

export function menuCommands(platform = detectPlatform()): Command[] {
  return [
    {
      id: 'edit.go_to_page',
      label: 'Go to Page…',
      description: 'Jump to a page by its number.',
      shortcut: 'Mod-Alt-g',
      menu: { id: 'edit', group: 'navigate', order: 10 },
      isEnabled: () => useStore.getState().layout.pageCount > 0,
      run: () => openMenuDialog('goToPage'),
    },
    {
      id: 'view.fullScreen',
      label: 'Full Screen',
      description: 'Fill the screen with the window, or go back to a normal window.',
      // macOS convention Ctrl+Cmd+F; F11 elsewhere.
      shortcut: platform === 'mac' ? 'Ctrl-Mod-f' : 'F11',
      menu: { id: 'view', group: 'window', order: 50 },
      isChecked: () => fullScreen,
      run: () => void toggleFullScreen(),
    },
    {
      id: 'help.shortcuts',
      label: 'Keyboard Shortcuts',
      description: 'List every keyboard shortcut, with a search box.',
      shortcut: 'Mod-/',
      menu: { id: 'help', group: 'help', order: 10 },
      run: () => openMenuDialog('shortcuts'),
    },
    {
      id: 'help.projectFormat',
      label: 'Project Folder Format',
      description: 'Read how a Novel project folder is laid out on disk. Works offline.',
      menu: { id: 'help', group: 'help', order: 20 },
      run: () => openMenuDialog('projectFormat'),
    },
    {
      id: 'help.about',
      label: 'About Novel',
      description: 'Show the version of Novel and its licence.',
      menu: { id: 'app', group: 'about', order: 10 },
      run: () => openMenuDialog('about'),
    },
  ]
}

/** Register the menu slice's own commands (Help, Go to Page, Full Screen). Returns unregister. */
export function registerMenuCommands(): () => void {
  const off = registerCommands(menuCommands())
  const onChange = () => {
    if (!isTauri()) fullScreen = !!document.fullscreenElement
    notifyCommandStateChanged()
  }
  document.addEventListener('fullscreenchange', onChange)
  return () => {
    document.removeEventListener('fullscreenchange', onChange)
    off()
  }
}
