import { TextSelection } from '@tiptap/pm/state'
import { getEditor } from '@/features/editor'
import { revealPosition, showPage } from '@/features/pagination'
import { useStore } from '@/shared/store'

/**
 * Go to an outline entry (click, Enter, tap): the caret to the start of its first block, its page or
 * spread shown, in Book mode and Scroll mode, and the focus back in the manuscript. `revealPosition`
 * finishes a pending progressive draw first (decision b4f377639), so the position is where it is
 * painted. An entry that opens its page (a chapter on a new page) shows that page from its top in
 * Scroll mode, as Word scrolls a heading to the top of the window. False with no manuscript mounted or
 * while a re-write is open over the pages.
 */
export function jumpTo(from: number, opts: { firstPage?: number | null } = {}): boolean {
  const editor = getEditor()
  if (!editor || editor.isDestroyed) return false
  if (useStore.getState().rewrite.openId !== null) return false
  const view = editor.view
  const doc = view.state.doc
  const inside = Math.max(0, Math.min(doc.content.size, from + 1))
  const sel = TextSelection.near(doc.resolve(inside), 1)
  // Flush the pending draw before the selection follows (hit tests and navigation read painted lines).
  revealPosition(sel.head)
  view.dispatch(view.state.tr.setSelection(sel).scrollIntoView())
  view.focus()
  revealPosition(sel.head)
  const page = opts.firstPage
  const pages = useStore.getState().layout.pages
  if (page !== null && page !== undefined && pages[page] && pages[page].from >= from) showPage(page)
  return true
}
