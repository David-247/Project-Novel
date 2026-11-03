import { useStore } from '@/shared/store'
import { Button, Dialog } from '@/shared/ui'
import { discardRecovery, openProject, restoreRecovery } from './project'

/** "Today at 14:05" style time for a snapshot (falls back to the raw string). */
export function formatSnapshotTime(iso: string, now: Date = new Date()): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  return d.toDateString() === now.toDateString() ? `today at ${time}` : `${d.toLocaleDateString()} at ${time}`
}

/**
 * Crash-recovery questions (rendered via a portal):
 * - "restore": a backup newer than the last save was found in the open project.
 * - "reopen": at startup, the last project has a backup left by a crash.
 * Closing with Escape / X decides nothing: the backup is kept and offered again next time.
 */
export function RecoveryDialog() {
  const prompt = useStore((s) => s.project.recoveryPrompt)
  const title = useStore((s) => s.project.title)
  const dismiss = () => useStore.getState().projectActions.dismissRecoveryPrompt()
  const onOpenChange = (open: boolean) => {
    if (!open) dismiss()
  }

  if (prompt?.kind === 'reopen') {
    return (
      <Dialog
        open
        onOpenChange={onOpenChange}
        title="Recover unsaved work?"
        description={`Novel closed unexpectedly while "${prompt.name}" had unsaved changes. Reopen it to recover them?`}
        closeLabel="Not now"
        footer={
          <>
            <Button data-control-id="recovery.dismiss" onClick={dismiss}>
              Not Now
            </Button>
            <Button
              variant="primary"
              data-control-id="recovery.reopen"
              onClick={() => {
                dismiss()
                void openProject(prompt.path)
              }}
            >
              Reopen Project
            </Button>
          </>
        }
      />
    )
  }

  return (
    <Dialog
      open={prompt?.kind === 'restore'}
      onOpenChange={onOpenChange}
      title="Restore unsaved changes?"
      description={
        prompt?.kind === 'restore'
          ? `${title ? `"${title}"` : 'This project'} has an automatic backup from ${formatSnapshotTime(prompt.savedAt)} ` +
            `that is newer than the last save. Restore it, or discard it and keep the last saved version?`
          : undefined
      }
      closeLabel="Decide later"
      footer={
        <>
          <Button variant="danger" data-control-id="recovery.discard" onClick={() => void discardRecovery()}>
            Discard Backup
          </Button>
          <Button variant="primary" data-control-id="recovery.restore" onClick={() => void restoreRecovery()}>
            Restore
          </Button>
        </>
      }
    />
  )
}
