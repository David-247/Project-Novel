import { registerCommands } from '@/shared/commands'
import { HEADER_FOOTER_CONTROLS } from './controls'
import { openHeaderFooterDialog } from './dialog-state'

/** File > Book Details… and Format > Headers & Page Numbers…. Returns unregister. */
export function registerHeaderFooterCommands(): () => void {
  return registerCommands([
    {
      id: HEADER_FOOTER_CONTROLS.details.id,
      label: 'Book Details…',
      description: 'Edit the book title and author used in the page headers.',
      menu: { id: 'file', group: 'book', order: 10 },
      run: () => openHeaderFooterDialog('details'),
    },
    {
      id: HEADER_FOOTER_CONTROLS.open.id,
      label: 'Headers & Page Numbers…',
      description: 'Set the page headers and page numbers.',
      menu: { id: 'format', group: 'book', order: 60 },
      run: () => openHeaderFooterDialog('settings'),
    },
  ])
}
