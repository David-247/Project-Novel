import { notifyCommandStateChanged, registerCommands, type Command } from '@/shared/commands'
import { useStore, type RecentProject } from '@/shared/store'
import { handleQuitRequest, SAVE_SHORTCUT } from './integration'
import { closeProjectInteractive, newProject, openProject, saveProject, saveProjectCopy } from './project'

const project = () => useStore.getState().project
const idle = () => !project().opening
const hasProject = () => project().path !== null && idle()

/** `file.open_recent.<n>`: the n-th entry of File > Open Recent. */
export const recentCommandId = (index: number) => `file.open_recent.${index}`
const RECENT_SUBMENU = 'Open Recent'

/** The File menu's storage commands (fixed part). */
export const STORAGE_COMMANDS: readonly Command[] = [
  {
    id: 'file.new_project',
    label: 'New Project…',
    description: 'Start a new project folder for a manuscript.',
    shortcut: 'Mod-Shift-n',
    menu: { id: 'file', group: 'project', order: 10 },
    isEnabled: idle,
    run: () => void newProject(),
  },
  {
    id: 'file.open_project',
    label: 'Open Project…',
    description: 'Open an existing project folder.',
    shortcut: 'Mod-o',
    menu: { id: 'file', group: 'project', order: 20 },
    isEnabled: idle,
    run: () => void openProject(),
  },
  {
    id: 'file.close_project',
    label: 'Close Project',
    description: 'Close the project and start an empty manuscript. Unsaved changes are offered first.',
    menu: { id: 'file', group: 'project', order: 40 },
    isEnabled: hasProject,
    run: () => void closeProjectInteractive(),
  },
  {
    id: 'file.save',
    label: 'Save',
    description: 'Save the manuscript to its project folder now. With no project open, choose a folder.',
    shortcut: SAVE_SHORTCUT,
    menu: { id: 'file', group: 'save', order: 10 },
    isEnabled: idle,
    run: () => void saveProject(),
  },
  {
    id: 'file.save_copy',
    label: 'Save a Copy…',
    description: 'Write a copy of the project to another folder and keep working in this one.',
    shortcut: 'Mod-Shift-s',
    menu: { id: 'file', group: 'save', order: 20 },
    isEnabled: hasProject,
    run: () => void saveProjectCopy(),
  },
  {
    id: 'app.quit',
    label: 'Quit Novel',
    description: 'Close Novel. Unsaved changes are offered first.',
    shortcut: 'Mod-q',
    menu: { id: 'app', group: 'quit', order: 100 },
    run: () => void handleQuitRequest(),
  },
]

/** Commands for the entries of the recent-projects list (or one disabled "No Recent Projects"). */
export function recentCommands(list: readonly RecentProject[]): Command[] {
  const menu = (order: number) => ({ id: 'file' as const, group: 'project', order: 30 + order / 100, submenu: RECENT_SUBMENU })
  if (list.length === 0) {
    return [
      {
        id: 'file.open_recent.empty',
        label: 'No Recent Projects',
        description: 'Projects you open are listed here.',
        menu: menu(0),
        isEnabled: () => false,
        run: () => {},
      },
    ]
  }
  return list.map((r, i) => ({
    id: recentCommandId(i),
    label: r.missing ? `${r.name} (missing)` : r.name,
    description: r.missing ? 'This project folder could not be found.' : 'Open this project again.',
    menu: menu(i),
    isEnabled: () => !r.missing && idle(),
    run: () => void openProject(r.path),
  }))
}

/**
 * Register the File menu's storage commands (New, Open, Open Recent, Close Project, Save, Save a Copy,
 * Quit). Open Recent follows the store's recent list. Returns unregister.
 */
export function registerStorageCommands(): () => void {
  const offFixed = registerCommands(STORAGE_COMMANDS)
  let offRecent = registerCommands(recentCommands(project().recent))
  const unsubscribe = useStore.subscribe((s, prev) => {
    if (s.project.recent !== prev.project.recent) {
      offRecent()
      offRecent = registerCommands(recentCommands(s.project.recent))
    }
    if (s.project.path !== prev.project.path || s.project.opening !== prev.project.opening) notifyCommandStateChanged()
  })
  return () => {
    unsubscribe()
    offRecent()
    offFixed()
  }
}
