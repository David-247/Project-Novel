import { useStore, type ProjectState } from '@/shared/store'

export function saveStatusText(p: Pick<ProjectState, 'path' | 'title' | 'saveStatus'> & { dirty: boolean }): string {
  if (p.saveStatus === 'saving') return 'Saving…'
  if (p.saveStatus === 'error') return 'Save failed'
  if (!p.path) return p.dirty ? 'Not saved: no project' : 'No project open'
  if (p.dirty) return 'Unsaved changes'
  return p.saveStatus === 'saved' ? 'Saved' : 'All changes saved'
}

/** Non-interactive status text for the status bar (announced politely to screen readers). */
export function SaveStatusIndicator() {
  const path = useStore((s) => s.project.path)
  const title = useStore((s) => s.project.title)
  // Unsaved changes: the editor slice's flag is the single source of truth.
  const dirty = useStore((s) => s.editor.dirty)
  const saveStatus = useStore((s) => s.project.saveStatus)
  const text = saveStatusText({ path, title, dirty, saveStatus })
  return (
    <span role="status" aria-live="polite" className="text-sm">
      {title ? `${title}: ${text}` : text}
    </span>
  )
}
