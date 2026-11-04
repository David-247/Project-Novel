import { BookDetailsDialog } from './BookDetailsDialog'
import { HeaderFooterDialog } from './HeaderFooterDialog'
import { HeaderFooterSlots } from './HeaderFooterSlots'

/** Slots in the page margins plus the two dialogs. Render once under the app's TooltipProvider. */
export function HeaderFooter() {
  return (
    <>
      <HeaderFooterSlots />
      <HeaderFooterDialog />
      <BookDetailsDialog />
    </>
  )
}
