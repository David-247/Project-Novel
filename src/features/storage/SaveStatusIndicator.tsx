import { useStore, type ProjectState } from '@/shared/store'
import { StatusText } from '@/shared/ui'

export function saveStatusText(
  p: Pick<ProjectState, 'path' | 'title' | 'saveStatus'> & { dirty: boolean; backedUp?: boolean },
): string {
  if (p.saveStatus === 'saving') return 'Saving…'
  if (p.saveStatus === 'error') return 'Save failed'
  if (!p.path) return p.dirty ? 'Not saved: no project' : 'No project open'
  if (p.dirty) return p.backedUp ? 'Unsaved changes (backed up)' : 'Unsaved changes'
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
  const backedUp = useStore((s) => s.project.lastBackupAt !== null)
  const warning = useStore((s) => s.project.backupWarning)
  const opening = useStore((s) => s.project.opening)
  const text = saveStatusText({ path, title, dirty, saveStatus, backedUp })
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
