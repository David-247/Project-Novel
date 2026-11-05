import { Plugin, PluginKey } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import { openPopoverForClick } from './popover-actions'
import { listChanges } from './review'
import { closeChangePopover, getChangePopover, getReviewView, isReviewView, refreshChangeSummary, scheduleChangeSummary, setReviewView } from './review-state'

export const reviewKey = new PluginKey('nvTrackReview')
const POPOVER_SELECTOR = '[data-testid="change-popover"]'

/** The popover's change is gone, or the caret left it (a click elsewhere, arrow keys). */
function caretLeft(view: EditorView): boolean {
  const p = getChangePopover()
  if (!p) return false
  const c = listChanges(view.state.doc).find((x) => x.id === p.id)
  if (!c) return true
  const { from, to } = view.state.selection
  return to < c.from || from > c.to
}

const focusInPopover = () => !!document.querySelector(POPOVER_SELECTOR)?.contains(document.activeElement)

/**
 * The review side of the manuscript view: keeps the change summary (status bar, by-author commands)
 * up to date, opens the change popover on a click or tap on a change (handleClick: never after a
 * drag-selection) and closes it on Escape, on any document change (typing, undo, a load) or when the
 * caret leaves the change. Every handler acts only in the view the review acts on
 * (`isReviewView`): another editor with the extension (the re-write view) is left alone.
 */
export function reviewPlugin(): Plugin {
  return new Plugin({
    key: reviewKey,
    props: {
      handleClick: (view, pos, event) => {
        if (isReviewView(view)) openPopoverForClick(view, pos, event)
        // The click still places the caret.
        return false
      },
      handleDOMEvents: {
        // The focus went elsewhere (the menu bar, a panel): a popover opened by a click closes, so it
        // never covers what the user turned to. Into the popover itself (Tab, a press) it stays.
        blur: (view, event) => {
          if (!isReviewView(view) || !getChangePopover()) return false
          const next = (event as FocusEvent).relatedTarget as Node | null
          if (next && document.querySelector(POPOVER_SELECTOR)?.contains(next)) return false
          requestAnimationFrame(() => {
            if (!focusInPopover() && document.activeElement !== getReviewView()?.dom) closeChangePopover()
          })
          return false
        },
      },
      handleKeyDown: (view, event) => {
        if (event.key !== 'Escape' || !getChangePopover() || !isReviewView(view)) return false
        closeChangePopover()
        return true
      },
    },
    view: (view) => {
      setReviewView(view)
      if (isReviewView(view)) refreshChangeSummary(view.state.doc)
      return {
        update: (v, prev) => {
          if (!isReviewView(v)) return
          const docChanged = v.state.doc !== prev.doc
          if (docChanged) {
            scheduleChangeSummary(v.state.doc)
            // Typing, undo, a load (also with the focus in the popover): the popover would sit over
            // changed lines. Accept / Reject close it themselves.
            closeChangePopover()
            return
          }
          // Only while it is open (never per keystroke otherwise); focus in it keeps it.
          if (v.state.selection !== prev.selection && getChangePopover() && !focusInPopover() && caretLeft(v)) closeChangePopover()
        },
        destroy: () => {
          const was = isReviewView(view)
          setReviewView(null, view)
          if (was) {
            closeChangePopover()
            refreshChangeSummary(getReviewView()?.state.doc ?? null)
          }
        },
      }
    },
  })
}
