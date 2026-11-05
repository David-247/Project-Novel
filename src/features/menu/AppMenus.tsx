import { useEffect } from 'react'
import { getActiveEditor } from '@/features/editor'
import { installCommandShortcuts, menuBarKind } from '@/shared/commands'
import { registerMenuCommands } from './commands'
import { MenuBar } from './MenuBar'
import { MenuDialogs } from './MenuDialogs'
import { startNativeMenu } from './native'

/**
 * Installs the registry's keyboard shortcuts, its own commands (Help, Go to Page, Full Screen) and the
 * native macOS menu sync; renders nothing. Mount once at the composition root.
 */
export function useAppMenus(): void {
  useEffect(() => {
    const offCommands = registerMenuCommands()
    const offKeys = installCommandShortcuts({ manuscript: () => getActiveEditor()?.view.dom })
    const offNative = startNativeMenu()
    return () => {
      offNative()
      offKeys()
      offCommands()
    }
  }, [])
}

/** The in-app menu bar, unless the platform shows the native one (macOS desktop app). */
export function AppMenuBar() {
  return menuBarKind() === 'in-app' ? <MenuBar /> : null
}

export { MenuDialogs }
