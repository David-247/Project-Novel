import { useStore, type ProjectState } from '@/shared/store'
import { StatusText } from '@/shared/ui'

/** Status while text typed without a project exists only in memory. */
export const NOT_SAVED_HINT = 'Not saved yet — choose Save as project to keep your work'

/** "12:04"-style local time of a backup. */
export function formatBackupTime(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

/**
 * With unsaved changes, the time of the last crash-recovery snapshot is shown ("Unsaved changes ·
 * backed up 12:04"), so it never reads as if edits made after that snapshot were backed up too.
 */
export function saveStatusText(
  p: Pick<ProjectState, 'path' | 'title' | 'saveStatus'> & { dirty: boolean; lastBackupAt?: number | null },
): string {
  if (p.saveStatus === 'saving') return 'Saving…'
  if (p.saveStatus === 'error') return 'Save failed'
  if (!p.path) return p.dirty ? NOT_SAVED_HINT : 'No project open'
  if (p.dirty) return p.lastBackupAt ? `Unsaved changes · backed up ${formatBackupTime(p.lastBackupAt)}` : 'Unsaved changes'
  return p.saveStatus === 'saved' ? 'Saved' : 'All changes saved'
}

/**
 * Status-bar save state (announced politely to screen readers), plus a
 * non-blocking warning while autosave snapshots fail.
 */
export function SaveStatusIndicator() {
  const path = useStore((s) => s.project.path)
  const title = useStore((s) => s.project.title)
  // Unsaved changes: the editor slice's flag is the single source of truth.
  const dirty = useStore((s) => s.editor.dirty)
  const saveStatus = useStore((s) => s.project.saveStatus)
  const lastBackupAt = useStore((s) => s.project.lastBackupAt)
  const warning = useStore((s) => s.project.backupWarning)
  const opening = useStore((s) => s.project.opening)
  const text = saveStatusText({ path, title, dirty, saveStatus, lastBackupAt })
  return (
    <>
      <span role="status" aria-live="polite" className="text-sm">
        {opening ? 'Opening…' : title ? `${title}: ${text}` : text}
      </span>
      {warning ? (
        <StatusText tone="warning" live className="ml-3" data-testid="autosave-warning">
          {warning}
        </StatusText>
      ) : null}
    </>
  )
}
