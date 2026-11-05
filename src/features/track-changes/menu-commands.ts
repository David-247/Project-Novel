import { notifyCommandStateChanged, registerCommands, type Command } from '@/shared/commands'
import { useStore } from '@/shared/store'
import { getMarkupView, isTracking, setMarkupView, toggleTrackChanges } from './commands'
import { BY_AUTHOR_SUBMENU, MARKUP_VIEW_OPTIONS, TRACK_CHANGES_CONTROLS } from './controls'
import { showChangeAtCaret } from './popover-actions'
import { nextChange, prevChange, resolveAll, resolveAndNext, resolveSelection } from './review-actions'
import { hasTrackedChanges } from './has-changes'
import { getChangeSummary, getReviewView, subscribeChangeSummary } from './review-state'

/**
 * The track changes commands for the registry: Review > Track Changes (check, Mod-Shift-e), the
 * review commands (Previous / Next Change, Show Change Details, Accept / Reject with Move to Next,
 * All and All by Author) and View > Markup > All / Simple / No Markup / Original (radio-style
 * checks). The registry places a command in one menu, so the markup views are in View only.
 */
export function trackChangesCommands(): Command[] {
  const track = TRACK_CHANGES_CONTROLS.track
  return [
    {
      id: track.id,
      label: track.label,
      description: track.description,
      shortcut: track.shortcut,
      menu: { id: 'review', group: 'tracking', order: 1 },
      // Harmless from any field (a footnote, the find field), but not behind a dialog.
      guard: 'modal',
      isChecked: () => isTracking(),
      run: () => void toggleTrackChanges(),
    },
    ...MARKUP_VIEW_OPTIONS.map(
      (o, i): Command => ({
        id: o.id,
        label: o.label,
        description: o.description,
        menu: { id: 'view', group: 'markup', order: 30 + i, submenu: 'Markup' },
        guard: 'modal',
        isChecked: () => getMarkupView() === o.value,
        run: () => setMarkupView(o.value),
      }),
    ),
    ...reviewCommands(),
  ]
}

/**
 * The manuscript holds a change now. Read from the current document (cached per node, so after an edit
 * only the edited block's path is looked at), not the debounced summary: Accept and Mod-Alt-a / r work
 * right after an edit or an undo.
 */
const hasChanges = () => {
  const v = getReviewView()
  return !!v && hasTrackedChanges(v.state.doc)
}
const canEdit = () => hasChanges() && !!getReviewView()?.editable

/**
 * Review > Previous / Next Change, Show Change Details, Accept / Reject (Change, and Move to Next,
 * All). Orders 2–9: between Track Changes (1) and the comments (10).
 */
export function reviewCommands(): Command[] {
  const C = TRACK_CHANGES_CONTROLS
  const cmd = (c: { id: string; label: string; description: string; shortcut?: string }, rest: Omit<Command, 'id' | 'label' | 'description'>): Command => ({
    id: c.id,
    label: c.label,
    description: c.description,
    ...(c.shortcut ? { shortcut: c.shortcut } : {}),
    ...rest,
  })
  return [
    // Navigation moves the manuscript's selection: allowed from anywhere (registry guard 'none').
    cmd(C.prevChange, { menu: { id: 'review', group: 'changes', order: 2 }, guard: 'none', isEnabled: hasChanges, run: () => void prevChange() }),
    cmd(C.nextChange, { menu: { id: 'review', group: 'changes', order: 3 }, guard: 'none', isEnabled: hasChanges, run: () => void nextChange() }),
    // Acts at the manuscript's caret. Always enabled while the manuscript is mounted, so the key is
    // never left to the browser (Alt+Enter would insert a line break there).
    cmd(C.showChange, { menu: { id: 'review', group: 'changes', order: 4 }, guard: 'manuscript', isEnabled: () => !!getReviewView(), run: () => void showChangeAtCaret() }),
    cmd(C.accept, { menu: { id: 'review', group: 'accept', order: 5 }, guard: 'manuscript', isEnabled: canEdit, run: () => void resolveSelection('accept') }),
    cmd(C.acceptNext, { menu: { id: 'review', group: 'accept', order: 5.1 }, guard: 'manuscript', isEnabled: canEdit, run: () => void resolveAndNext('accept') }),
    cmd(C.acceptAll, { menu: { id: 'review', group: 'accept', order: 5.2 }, guard: 'modal', isEnabled: canEdit, run: () => void resolveAll('accept') }),
    cmd(C.reject, { menu: { id: 'review', group: 'reject', order: 6 }, guard: 'manuscript', isEnabled: canEdit, run: () => void resolveSelection('reject') }),
    cmd(C.rejectNext, { menu: { id: 'review', group: 'reject', order: 6.1 }, guard: 'manuscript', isEnabled: canEdit, run: () => void resolveAndNext('reject') }),
    cmd(C.rejectAll, { menu: { id: 'review', group: 'reject', order: 6.2 }, guard: 'modal', isEnabled: canEdit, run: () => void resolveAll('reject') }),
  ]
}

/**
 * `review.acceptAll.author.<name>` / `review.rejectAll.author.<name>` (the name URI-encoded): keyed by
 * the author, so a stale native-menu item resolves that author's changes or, once the author has none
 * left, nothing.
 */
export const byAuthorCommandId = (mode: 'accept' | 'reject', author: string) => `review.${mode}All.author.${encodeURIComponent(author)}`

/**
 * Review > Accept All by Author ▸ / Reject All by Author ▸: one item per author present (in document
 * order). Re-registered when the authors change. With no changes, one disabled "No changes" item.
 */
export function byAuthorCommands(authors: readonly string[]): Command[] {
  const out: Command[] = []
  for (const mode of ['accept', 'reject'] as const) {
    const submenu = BY_AUTHOR_SUBMENU[mode]
    const order = mode === 'accept' ? 5.3 : 6.3
    const verb = mode === 'accept' ? 'Keep' : 'Undo'
    if (authors.length === 0) {
      out.push({
        id: `review.${mode}All.noAuthors`,
        label: 'No Changes',
        description: 'The book has no tracked changes.',
        menu: { id: 'review', group: mode, order, submenu },
        guard: 'modal',
        isEnabled: () => false,
        run: () => {},
      })
      continue
    }
    authors.forEach((author, i) =>
      out.push({
        id: byAuthorCommandId(mode, author),
        label: author,
        description: `${verb} every tracked change by ${author}. Other people's changes stay.`,
        menu: { id: 'review', group: mode, order: order + i / 1000, submenu },
        guard: 'modal',
        isEnabled: () => !!getReviewView()?.editable,
        run: () => void resolveAll(mode, author),
      }),
    )
  }
  return out
}

/**
 * Register the commands and keep their check marks fresh. Also drops the status-bar notice (an edit
 * recorded untracked) when another project is opened or the project is closed: it was about that
 * project's text, like the storage warnings the project slice clears then. Returns unregister.
 */
export function registerTrackChangesCommands(): () => void {
  const off = registerCommands(trackChangesCommands())
  let authors = getChangeSummary().authors
  let offAuthors = registerCommands(byAuthorCommands(authors))
  const offSummary = subscribeChangeSummary(() => {
    const next = getChangeSummary().authors
    if (next !== authors && (next.length !== authors.length || next.some((a, i) => a !== authors[i]))) {
      authors = next
      offAuthors()
      offAuthors = registerCommands(byAuthorCommands(authors))
    }
    notifyCommandStateChanged()
  })
  const offStore = useStore.subscribe((s, prev) => {
    if (s.book.trackChanges !== prev.book.trackChanges || s.trackChanges.markupView !== prev.trackChanges.markupView) notifyCommandStateChanged()
    if (s.project.path !== prev.project.path && s.trackChanges.notice) s.trackChangesActions.setNotice(null)
  })
  return () => {
    offStore()
    offSummary()
    offAuthors()
    off()
  }
}
