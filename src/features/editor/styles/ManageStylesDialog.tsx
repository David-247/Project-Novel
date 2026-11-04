import { useEffect, useId, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { styleToInlineCSS, type ResolvedStyle } from '@/shared/book'
import { Button, cn, Dialog, focusRing, TextInput, Tooltip } from '@/shared/ui'
import { countStyleUses, createStyle, deleteStyle, deleteTarget, duplicateStyle, renameStyle } from './actions'
import { STYLE_DIALOG_CONTROLS as C } from './controls'
import { useResolvedStyles } from './resolved'

export interface ManageStylesDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Style selected when the dialog opens (e.g. the current paragraph's). */
  initialStyleId?: string
  /** Open "Modify style" for a style (stacked over this dialog). */
  onModify: (styleId: string) => void
}

/** Specimen of a style name: its own face, weight, slant and case, at a size that fits a list row. */
function specimen(s: ResolvedStyle): CSSProperties {
  const css = styleToInlineCSS({
    fontFamily: s.fontFamily,
    fontWeight: s.fontWeight,
    italic: s.italic,
    textTransform: s.textTransform,
    // Wide tracking (Scene Break's 0.5 em) would make a list row unreadable: capped for the specimen.
    letterSpacing: s.letterSpacing === undefined ? undefined : Math.min(s.letterSpacing, 0.12),
  }) as CSSProperties
  const size = Math.min(17, Math.max(13, (s.fontSize ?? 11) * 1.25))
  return { ...css, fontSize: `${size}px`, lineHeight: 1.25 }
}

type Pending = { kind: 'rename'; value: string } | { kind: 'delete'; uses: number; target: string } | null

/** "Manage styles": every style in the book, with new, duplicate, rename, modify and delete. */
export function ManageStylesDialog({ open, onOpenChange, initialStyleId, onModify }: ManageStylesDialogProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Manage styles"
      description="Styles shape every paragraph that uses them. Built-in styles can be modified but not renamed or deleted."
      className="sm:max-w-xl"
    >
      {/* Mounted only while open, so each opening starts fresh. */}
      <ManageStylesBody initialStyleId={initialStyleId} onModify={onModify} />
    </Dialog>
  )
}

function ManageStylesBody({ initialStyleId, onModify }: Pick<ManageStylesDialogProps, 'initialStyleId' | 'onModify'>) {
  const styles = useResolvedStyles()
  const [selected, setSelected] = useState(() => (initialStyleId && styles.has(initialStyleId) ? initialStyleId : 'body'))
  const [pending, setPending] = useState<Pending>(null)
  const [status, setStatus] = useState('')
  const groupName = useId()
  const renameRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (pending?.kind === 'rename') renameRef.current?.select()
  }, [pending?.kind])

  const current = styles.get(selected) ?? styles.get('body')!
  const list = [...styles.values()]
  const chapter = list.filter((s) => s.kind === 'chapter')
  const paragraph = list.filter((s) => s.kind === 'paragraph')

  const select = (id: string) => {
    setSelected(id)
    setPending(null)
  }

  const commitRename = () => {
    if (pending?.kind !== 'rename') return
    if (renameStyle(current.id, pending.value)) setStatus(`Renamed to ${pending.value.trim()}.`)
    setPending(null)
  }

  const row = (s: ResolvedStyle) => (
    <li key={s.id}>
      <Tooltip side="right">
        <button
          type="button"
          aria-pressed={s.id === current.id}
          data-control-id={C.manageItem.id}
          data-style-row={s.id}
          onClick={() => select(s.id)}
          className={cn(
            'flex min-h-control w-full cursor-pointer items-baseline gap-3 rounded-control px-3 py-1.5 text-left',
            focusRing,
            s.id === current.id ? 'bg-accent-soft text-accent' : 'text-text hover:bg-surface-hover',
          )}
        >
          <span className="min-w-0 flex-1 truncate" style={specimen(s)}>
            {s.name}
          </span>
          {s.builtIn ? null : <span className="shrink-0 font-sans text-ui-xs text-text-muted">Custom</span>}
        </button>
      </Tooltip>
    </li>
  )

  const group = (title: string, items: ResolvedStyle[]) =>
    items.length ? (
      <div role="group" aria-label={title}>
        <h3 className="m-0 px-3 pb-1 pt-2 text-ui-xs font-semibold text-text-muted">{title}</h3>
        <ul className="m-0 flex list-none flex-col gap-0.5 p-0">{items.map(row)}</ul>
      </div>
    ) : null

  const action = (key: 'manageNew' | 'manageDuplicate' | 'manageRename' | 'manageModify' | 'manageDelete', onClick: () => void, disabled = false, variant: 'secondary' | 'danger' = 'secondary') => (
    <Tooltip>
      <Button data-control-id={C[key].id} variant={variant === 'danger' ? 'secondary' : variant} disabled={disabled} onClick={onClick} className={variant === 'danger' ? 'text-danger' : undefined}>
        {C[key].label}
      </Button>
    </Tooltip>
  )

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto]">
        <div role="group" aria-label="Styles" className="max-h-[50dvh] overflow-auto rounded-panel border border-border bg-surface py-1">
          {group('Chapter styles', chapter)}
          {group('Paragraph styles', paragraph)}
        </div>
        <div className="flex flex-row flex-wrap content-start gap-2 sm:w-36 sm:flex-col">
          {action('manageNew', () => {
            const id = createStyle(current.id)
            setSelected(id)
            setStatus(`Created a style based on ${current.name}.`)
            setPending({ kind: 'rename', value: styles.get(id)?.name ?? 'New style' })
          })}
          {action('manageDuplicate', () => {
            const id = duplicateStyle(current.id)
            if (id) {
              setSelected(id)
              setStatus(`Duplicated ${current.name}.`)
            }
          })}
          {action('manageRename', () => setPending({ kind: 'rename', value: current.name }), current.builtIn)}
          {action('manageModify', () => onModify(current.id))}
          {action('manageDelete', () => {
            const target = deleteTarget(current.id)
            setPending({ kind: 'delete', uses: countStyleUses(current.id), target: styles.get(target)?.name ?? 'Body' })
          }, current.builtIn, 'danger')}
        </div>
      </div>

      {pending?.kind === 'rename' ? (
        <form
          className="mt-4 flex flex-wrap items-end gap-2 rounded-panel border border-border p-3"
          onSubmit={(e) => {
            e.preventDefault()
            commitRename()
          }}
        >
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <label htmlFor={`${groupName}-rename`} className="text-ui-xs font-medium text-text-muted">
              {C.manageRenameField.label}
            </label>
            <Tooltip>
              <TextInput
                ref={renameRef}
                id={`${groupName}-rename`}
                data-control-id={C.manageRenameField.id}
                value={pending.value}
                maxLength={80}
                aria-invalid={!pending.value.trim() || undefined}
                onChange={(e) => setPending({ kind: 'rename', value: e.target.value })}
              />
            </Tooltip>
          </div>
          <Tooltip>
            <Button data-control-id={C.manageRenameCancel.id} onClick={() => setPending(null)}>
              Cancel
            </Button>
          </Tooltip>
          <Tooltip>
            <Button type="submit" variant="primary" data-control-id={C.manageRenameSave.id} disabled={!pending.value.trim()}>
              {C.manageRenameSave.label}
            </Button>
          </Tooltip>
        </form>
      ) : null}

      {pending?.kind === 'delete' ? (
        <div role="alert" className="mt-4 flex flex-wrap items-center gap-2 rounded-panel border border-danger p-3">
          <p className="m-0 min-w-0 flex-1 text-ui-sm">
            Delete <strong>{current.name}</strong>?{' '}
            {pending.uses === 0
              ? 'No paragraphs use it.'
              : `${pending.uses} ${pending.uses === 1 ? 'paragraph uses' : 'paragraphs use'} it and will switch to ${pending.target}.`}
          </p>
          <Tooltip>
            <Button data-control-id={C.manageDeleteCancel.id} onClick={() => setPending(null)}>
              {C.manageDeleteCancel.label}
            </Button>
          </Tooltip>
          <Tooltip>
            <Button
              variant="danger"
              data-control-id={C.manageDeleteConfirm.id}
              onClick={() => {
                const name = current.name
                const target = deleteTarget(current.id)
                deleteStyle(current.id)
                setSelected(target)
                setPending(null)
                setStatus(`Deleted ${name}.`)
              }}
            >
              {C.manageDeleteConfirm.label}
            </Button>
          </Tooltip>
        </div>
      ) : null}

      <p role="status" aria-live="polite" className="m-0 min-h-5 pt-2 text-ui-xs text-text-muted">
        {status}
      </p>
    </>
  )
}
