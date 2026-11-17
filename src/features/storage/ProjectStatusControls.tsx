import type { ReactNode } from 'react'
import { useStore } from '@/shared/store'
import { Button, StatusText, Tooltip } from '@/shared/ui'
import { newProject, openProject, reopenRecoveryPrompt, saveProject } from './project'

/**
 * In-window project actions while no project is open, so a first-time user who never finds the
 * native File menu is not trapped: New project…, Open project…, and (once there is unsaved text)
 * Save as project…. Same control ids, and so the same tooltips, as the File menu items.
 */
/** In a narrow status bar (`statusbar` container) the buttons show an icon; the label stays as the name. */
function Label({ text, icon }: { text: string; icon: ReactNode }) {
  return (
    <>
      <span className="@max-[800px]/statusbar:sr-only">{text}</span>
      <svg
        aria-hidden="true"
        viewBox="0 0 16 16"
        className="size-4 @min-[800px]/statusbar:hidden"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {icon}
      </svg>
    </>
  )
}

export function NoProjectActions() {
  const path = useStore((s) => s.project.path)
  const dirty = useStore((s) => s.editor.dirty || s.book.dirty)
  const opening = useStore((s) => s.project.opening)
  if (path) return null
  return (
    <div role="group" aria-label="Project" className="flex shrink-0 items-center gap-1">
      {dirty ? (
        <Tooltip side="top">
          <Button variant="primary" data-control-id="file.save" disabled={opening} onClick={() => void saveProject()}>
            <Label text="Save as project…" icon={<path d="M3 2.5h8l2.5 2.5v8.5h-10.5zM5.5 2.5v3.5h5v-3.5M5 13.5v-4h6v4" />} />
          </Button>
        </Tooltip>
      ) : null}
      <Tooltip side="top">
        <Button variant="ghost" data-control-id="file.new_project" disabled={opening} onClick={() => void newProject()}>
          <Label text="New project…" icon={<path d="M4 1.5h5.5l3 3v10h-8.5zM9.5 1.5v3h3M8.25 7.5v5M5.75 10h5" />} />
        </Button>
      </Tooltip>
      <Tooltip side="top">
        <Button variant="ghost" data-control-id="file.open_project" disabled={opening} onClick={() => void openProject()}>
          <Label text="Open project…" icon={<path d="M1.5 3.5h4.5l1.5 1.5h7v8.5h-13z" />} />
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
  const bookWarning = useStore((s) => s.project.bookWarning)
  const sideFileWarning = useStore((s) => s.project.sideFileWarning)
  return (
    <>
      {pendingAt && !promptOpen ? (
        <Tooltip side="top">
          <Button
            variant="ghost"
            data-control-id="recovery.reopenPrompt"
            // The full name also when a narrow status bar shows only "Restore…".
            aria-label="Backup available — Restore…"
            onClick={() => reopenRecoveryPrompt()}
          >
            <span className="@max-[640px]/statusbar:hidden">Backup available — </span>Restore…
          </Button>
        </Tooltip>
      ) : null}
      {bookWarning ? (
        <StatusText tone="warning" live className="min-w-0 truncate" data-testid="book-warning" title={bookWarning}>
          {bookWarning}
        </StatusText>
      ) : null}
      {sideFileWarning ? (
        <StatusText tone="warning" live className="min-w-0 truncate" data-testid="side-file-warning" title={sideFileWarning}>
          {sideFileWarning}
        </StatusText>
      ) : null}
      {notice ? (
        <StatusText live className="min-w-0 truncate" data-testid="recovery-notice" title={notice}>
          {notice}
        </StatusText>
      ) : null}
    </>
  )
}
