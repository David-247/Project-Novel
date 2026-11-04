import { useId, useState } from 'react'
import type { FormEvent } from 'react'
import { updateProjectDetails } from '@/features/storage'
import { useStore } from '@/shared/store'
import { Button, Dialog, TextInput, Tooltip } from '@/shared/ui'
import { HEADER_FOOTER_CONTROLS as C } from './controls'
import { openHeaderFooterDialog, useOpenDialog } from './dialog-state'

/**
 * "Book details": the title and author that running heads can show. They live in project.json
 * (the project's metadata), not in book.json, and are written as soon as they are saved.
 * Reached from the Headers & page numbers dialog, which it returns to.
 */
export function BookDetailsDialog() {
  const open = useOpenDialog() === 'details'
  const back = () => openHeaderFooterDialog('settings')
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && back()}
      title="Book details"
      description="The title and author are saved in the project and can appear in the page headers."
    >
      {open ? <DetailsForm onDone={back} /> : null}
    </Dialog>
  )
}

function DetailsForm({ onDone }: { onDone: () => void }) {
  const title0 = useStore((s) => s.project.title) ?? ''
  const author0 = useStore((s) => s.project.author)
  const [title, setTitle] = useState(title0)
  const [author, setAuthor] = useState(author0)
  const [busy, setBusy] = useState(false)
  const id = useId()
  const titleMissing = !title.trim()

  const save = async (e?: FormEvent) => {
    e?.preventDefault()
    if (titleMissing || busy) return
    setBusy(true)
    const ok = await updateProjectDetails({ title, author })
    setBusy(false)
    if (ok) onDone()
  }

  return (
    <form onSubmit={save} className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-title`} className="text-ui-xs font-medium text-text-muted">
          {C.detailsTitle.label}
        </label>
        <Tooltip>
          <TextInput
            id={`${id}-title`}
            data-control-id={C.detailsTitle.id}
            value={title}
            maxLength={200}
            autoFocus
            aria-invalid={titleMissing || undefined}
            onChange={(e) => setTitle(e.target.value)}
          />
        </Tooltip>
        {titleMissing ? <p className="m-0 text-ui-xs text-danger">A book needs a title.</p> : null}
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-author`} className="text-ui-xs font-medium text-text-muted">
          {C.detailsAuthor.label}
        </label>
        <Tooltip>
          <TextInput
            id={`${id}-author`}
            data-control-id={C.detailsAuthor.id}
            value={author}
            maxLength={200}
            onChange={(e) => setAuthor(e.target.value)}
          />
        </Tooltip>
      </div>
      <div className="flex flex-wrap justify-end gap-2 pt-1">
        <Tooltip>
          <Button data-control-id={C.detailsCancel.id} onClick={onDone}>
            {C.detailsCancel.label}
          </Button>
        </Tooltip>
        <Tooltip>
          <Button type="submit" variant="primary" data-control-id={C.detailsSave.id} disabled={titleMissing || busy}>
            {C.detailsSave.label}
          </Button>
        </Tooltip>
      </div>
    </form>
  )
}
