import { notifyCommandStateChanged, registerCommands } from '@/shared/commands'
import { useStore } from '@/shared/store'
import { HEADER_FOOTER_CONTROLS } from './controls'
import { openHeaderFooterDialog } from './dialog-state'

const projectOpen = () => useStore.getState().project.path !== null

/** File > Book Details… and Format > Headers & Page Numbers…. Returns unregister. */
export function registerHeaderFooterCommands(): () => void {
  const off = registerCommands([
    {
      id: HEADER_FOOTER_CONTROLS.details.id,
      label: 'Book Details…',
      description: 'Edit the book title and author used in the page headers.',
      menu: { id: 'file', group: 'book', order: 10 },
      // Title and author live in project.json: only with a project open (as in the Headers dialog).
      isEnabled: projectOpen,
      run: () => {
        if (projectOpen()) openHeaderFooterDialog('details')
      },
    },
    {
      id: HEADER_FOOTER_CONTROLS.open.id,
      label: 'Headers & Page Numbers…',
      description: 'Set the page headers and page numbers.',
      menu: { id: 'format', group: 'book', order: 60 },
      run: () => openHeaderFooterDialog('settings'),
    },
  ])
  const unsubscribe = useStore.subscribe((s, p) => {
    if (s.project.path !== p.project.path) notifyCommandStateChanged()
  })
  return () => {
    unsubscribe()
    off()
  }
}
