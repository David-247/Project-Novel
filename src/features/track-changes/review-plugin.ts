import { Plugin, PluginKey } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import { openPopoverForClick } from './popover-actions'
import { listChanges } from './review'
import { closeChangePopover, getChangePopover, getReviewView, refreshChangeSummary, scheduleChangeSummary, setReviewView } from './review-state'

export const reviewKey = new PluginKey('nvTrackReview')
const POPOVER_SELECTOR = '[data-testid="change-popover"]'

/** The popover's change is gone, or the caret left it (a click elsewhere, arrow keys). */
function popoverStale(view: EditorView, docChanged: boolean): boolean {
  const p = getChangePopover()
  if (!p) return false
  const c = listChanges(view.state.doc).find((x) => x.id === p.id)
  if (!c) return true
  if (docChanged) return false
  const { from, to } = view.state.selection
  return to < c.from || from > c.to
}

/**
 * The review side of the manuscript view: makes it the view the review commands act on, keeps the
 * change summary (status bar, by-author commands) up to date, opens the change popover on a click or
 * tap on a change (handleClick: never after a drag-selection) and closes it on Escape or when the
 * caret leaves the change.
 */
export function reviewPlugin(): Plugin {
  return new Plugin({
    key: reviewKey,
    props: {
      handleClick: (view, pos, event) => {
        openPopoverForClick(view, pos, event)
        // The click still places the caret.
        return false
      },
      handleDOMEvents: {
        // The focus went elsewhere (the menu bar, a panel): a popover opened by a click closes, so it
        // never covers what the user turned to. Into the popover itself (Tab, a press) it stays.
        blur: (_view, event) => {
          const next = (event as FocusEvent).relatedTarget as Node | null
          if (getChangePopover() && !(next && document.querySelector(POPOVER_SELECTOR)?.contains(next))) {
            requestAnimationFrame(() => {
              if (!document.querySelector(POPOVER_SELECTOR)?.contains(document.activeElement) && document.activeElement !== getReviewView()?.dom) closeChangePopover()
            })
          }
          return false
        },
      },
      handleKeyDown: (_view, event) => {
        if (event.key !== 'Escape' || !getChangePopover()) return false
        closeChangePopover()
        return true
      },
    },
    view: (view) => {
      setReviewView(view)
      refreshChangeSummary(view.state.doc)
      return {
        update: (v, prev) => {
          const docChanged = v.state.doc !== prev.doc
          if (docChanged) scheduleChangeSummary(v.state.doc)
          // Focus in the popover (its buttons) keeps it: Tab does not move the caret.
          if ((docChanged || v.state.selection !== prev.selection) && getChangePopover() && !document.querySelector(POPOVER_SELECTOR)?.contains(document.activeElement)) {
            if (popoverStale(v, docChanged)) closeChangePopover()
          }
        },
        destroy: () => {
          if (getReviewView() === view || getReviewView() === null) {
            setReviewView(null)
            closeChangePopover()
            refreshChangeSummary(null)
          }
        },
      }
    },
  })
}
