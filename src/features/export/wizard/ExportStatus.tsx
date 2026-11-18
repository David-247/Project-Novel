import { useEffect, useState } from 'react'
import { Button, Tooltip } from '@/shared/ui'
import { revealInFolder } from '../platform'
import { EXPORT_WIZARD_CONTROLS as C } from './controls'
import { cancelExport, dismissRun, retryExport, useWizardState, type RunState } from './controller'
import { fileActionProblem } from './file-actions'
import { usedFontNote } from './font-note'
import { fileNameOf } from './title-page'

/** How long the "Exported" notice stays (ms). */
export const EXPORT_DONE_NOTICE_MS = 12_000

/**
 * The status bar's notice for File > Export > Export Manuscript Again (which runs without the wizard):
 * progress with Cancel, an error with Retry, then "Exported …" with Show in folder. Render in the
 * status bar.
 */
export function ExportStatus() {
  const { run, open } = useWizardState()
  // A Show in folder failure, for the run it is about: shown only while that run is done, so a later
  // run (even to the same path, as `written` is a new array for every run) or another phase shows none.
  const [failed, setFailed] = useState<{ written: RunState['written']; text: string } | null>(null)
  const show = run.origin === 'again' && !open && run.phase !== 'ready' && run.phase !== 'choosing'
  useEffect(() => {
    if (!show || (run.phase !== 'done' && run.phase !== 'cancelled')) return
    const t = setTimeout(dismissRun, EXPORT_DONE_NOTICE_MS)
    return () => clearTimeout(t)
  }, [show, run.phase])
  if (!show) return null
  const button = (meta: { id: string; label: string }, onClick: () => void, label?: string) => (
    <Tooltip side="top">
      <Button data-control-id={meta.id} aria-label={label} className="min-h-6 px-2 text-ui-xs" onClick={onClick}>
        {meta.label}
      </Button>
    </Tooltip>
  )
  const first = run.written[0]
  // The PDF set in another font than the settings name (B-I2): said here too, Export Again has no wizard.
  const fontNote = run.phase === 'done' ? run.written.map((w) => usedFontNote(w.font)).find(Boolean) ?? null : null
  const problem = failed && failed.written === run.written && run.phase === 'done' ? failed.text : null
  return (
    <span className="flex min-w-0 items-center gap-2 text-ui-xs" data-testid="export-status">
      <span role={run.phase === 'error' ? 'alert' : 'status'} className="min-w-0 truncate" title={run.error?.message ?? fontNote ?? undefined}>
        {run.phase === 'rendering' || run.phase === 'saving'
          ? `Exporting the manuscript… ${Math.round(run.progress * 100)}%`
          : run.phase === 'done'
            ? `Exported ${run.written.map((w) => fileNameOf(w.path)).join(' and ')}${fontNote ? `. ${fontNote}` : ''}`
            : run.phase === 'cancelled'
              ? 'Export cancelled. No file was written.'
              : `Export failed: ${run.error?.message ?? ''}`}
      </span>
      {run.phase === 'rendering' ? button(C.statusCancel, cancelExport) : null}
      {run.phase === 'error' ? button(C.statusRetry, () => void retryExport()) : null}
      {run.phase === 'done' && first
        ? button(C.statusShow, () => {
            setFailed(null)
            const written = run.written
            revealInFolder(first.path).catch((e: unknown) => setFailed({ written, text: fileActionProblem(e, 'show', fileNameOf(first.path)) }))
          })
        : null}
      {problem ? (
        <span role="alert" className="text-danger" data-testid="file-action-error">
          {problem}
        </span>
      ) : null}
      {run.phase === 'done' || run.phase === 'error' || run.phase === 'cancelled' ? button(C.statusDismiss, dismissRun) : null}
    </span>
  )
}
