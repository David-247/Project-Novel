import { notifyCommandStateChanged, registerCommands, type Command } from '@/shared/commands'
import { useStore } from '@/shared/store'
import { getMarkupView, isTracking, setMarkupView, toggleTrackChanges } from './commands'
import { MARKUP_VIEW_OPTIONS, TRACK_CHANGES_CONTROLS } from './controls'

/**
 * The track changes commands for the registry: Review > Track Changes (check, Mod-Shift-e) and
 * View > Markup > All / Simple / No Markup / Original (radio-style checks). The registry places a
 * command in one menu, so the markup views are in View only.
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
  ]
}

/**
 * Register the commands and keep their check marks fresh. Also drops the status-bar notice (an edit
 * recorded untracked) when another project is opened or the project is closed: it was about that
 * project's text, like the storage warnings the project slice clears then. Returns unregister.
 */
export function registerTrackChangesCommands(): () => void {
  const off = registerCommands(trackChangesCommands())
  const offStore = useStore.subscribe((s, prev) => {
    if (s.book.trackChanges !== prev.book.trackChanges || s.trackChanges.markupView !== prev.trackChanges.markupView) notifyCommandStateChanged()
    if (s.project.path !== prev.project.path && s.trackChanges.notice) s.trackChangesActions.setNotice(null)
  })
  return () => {
    offStore()
    off()
  }
}
