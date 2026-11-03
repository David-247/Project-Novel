import { useStore } from '@/shared/store'
import { Button, StatusText, Tooltip } from '@/shared/ui'
import { newProject, openProject, reopenRecoveryPrompt, saveProject } from './project'

/**
 * In-window project actions while no project is open, so a first-time user who never finds the
 * native File menu is not trapped: New project…, Open project…, and (once there is unsaved text)
 * Save as project…. Same control ids, and so the same tooltips, as the File menu items.
 */
export function NoProjectActions() {
  const path = useStore((s) => s.project.path)
  const dirty = useStore((s) => s.editor.dirty)
  const opening = useStore((s) => s.project.opening)
  if (path) return null
  return (
    <div role="group" aria-label="Project" className="flex shrink-0 items-center gap-1">
      {dirty ? (
        <Tooltip side="top">
          <Button variant="primary" data-control-id="file.save" disabled={opening} onClick={() => void saveProject()}>
            Save as project…
          </Button>
        </Tooltip>
      ) : null}
      <Tooltip side="top">
        <Button variant="ghost" data-control-id="file.new_project" disabled={opening} onClick={() => void newProject()}>
          New project…
        </Button>
      </Tooltip>
      <Tooltip side="top">
        <Button variant="ghost" data-control-id="file.open_project" disabled={opening} onClick={() => void openProject()}>
          Open project…
        </Button>
      </Tooltip>
    </div>
  )
}

/**
 * Crash-recovery state that must stay visible without a modal:
 * - "Backup available — Restore…" while a backup found on open is unanswered (the user chose
 *   "Decide later"); it re-opens the Restore / Discard question.
 * - A one-off note when set-aside `.recovery/unrestored-*.json` backups exist.
 */
export function RecoveryStatus() {
  const pendingAt = useStore((s) => s.project.pendingRecoveryAt)
  const promptOpen = useStore((s) => s.project.recoveryPrompt !== null)
  const notice = useStore((s) => s.project.recoveryNotice)
  return (
    <>
      {pendingAt && !promptOpen ? (
        <Tooltip side="top">
          <Button variant="ghost" data-control-id="recovery.reopenPrompt" onClick={() => reopenRecoveryPrompt()}>
            Backup available — Restore…
          </Button>
        </Tooltip>
      ) : null}
      {notice ? (
        <StatusText live className="min-w-0 truncate" data-testid="recovery-notice" title={notice}>
          {notice}
        </StatusText>
      ) : null}
    </>
  )
}
