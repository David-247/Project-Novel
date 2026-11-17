import { useEffect } from 'react'
import { onFootnotesChange, getFootnotes, type FootnoteRef } from '@/features/editor'
import { invalidatePaginationAt, registerBottomReservation, registerPageSlot, relayoutPagination } from '@/features/pagination'
import { useStore } from '@/shared/store'
import { FootnoteArea } from './FootnoteArea'
import { clearNoteMeasurements } from './note-dom'
import { clearAreas, reserveFootnotes } from './reservation'
import './footnotes.css'

/** Positions of references whose label changed while their block did not (their line boxes may have). */
export function relabelled(next: readonly FootnoteRef[], prev: readonly FootnoteRef[]): number[] {
  if (prev.length === 0) return []
  const before = new Map(prev.map((r) => [r.node, r.label]))
  const out: number[] = []
  for (const r of next) {
    const was = before.get(r.node)
    if (was !== undefined && was !== r.label) out.push(r.pos)
  }
  return out
}

/**
 * Footnotes on pages: the bottom reservation (only while the manuscript has footnotes, so a book
 * without any pays nothing), the 'reserved' page slot that draws each page's area, and the
 * invalidations the engine cannot see (a renumbered reference, a footnote option, a web font).
 * Returns the uninstall function.
 */
export function installFootnotePagination(): () => void {
  let unreserve: (() => void) | null = null
  const sync = (refs: readonly FootnoteRef[]) => {
    if (refs.length > 0 && !unreserve) unreserve = registerBottomReservation('footnotes', reserveFootnotes)
    else if (refs.length === 0 && unreserve) {
      unreserve()
      unreserve = null
      clearAreas()
    }
  }
  const unslot = registerPageSlot({ id: 'footnotes', region: 'reserved', render: ({ page }) => <FootnoteArea pageIndex={page.index} /> })
  const unlisten = onFootnotesChange((next, prev) => {
    sync(next)
    // A reference whose number changed width ("9" -> "10") changes its line, not its block node.
    invalidatePaginationAt(relabelled(next, prev))
  })
  sync(getFootnotes())
  let prev = useStore.getState().book
  let prevView = useStore.getState().trackChanges.markupView
  const unstore = useStore.subscribe((s) => {
    const p = prev
    prev = s.book
    // Track changes: the markup view hides or shows text inside notes (their heights change).
    const viewChanged = s.trackChanges.markupView !== prevView
    prevView = s.trackChanges.markupView
    if (viewChanged) clearNoteMeasurements()
    // The separator and the Footnote Text style change the areas without a document change.
    if (unreserve && (viewChanged || s.book.footnotes !== p.footnotes || s.book.styles !== p.styles)) relayoutPagination()
  })
  const fonts = (document as Document & { fonts?: FontFaceSet }).fonts
  const onFonts = () => clearNoteMeasurements()
  fonts?.addEventListener?.('loadingdone', onFonts)
  return () => {
    fonts?.removeEventListener?.('loadingdone', onFonts)
    unstore()
    unlisten()
    unslot()
    unreserve?.()
    clearAreas()
  }
}

/** Mount once (composition root) next to the paginated view. */
export function useFootnotePagination(): void {
  useEffect(() => installFootnotePagination(), [])
}
