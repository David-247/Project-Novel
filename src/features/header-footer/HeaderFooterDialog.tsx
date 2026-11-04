import { useId, useState } from 'react'
import type { ReactElement } from 'react'
import { useStore } from '@/shared/store'
import { Button, Checkbox, Dialog, Select, TextInput, Tooltip, cn } from '@/shared/ui'
import type { SelectOption } from '@/shared/ui'
import {
  MAX_START_NUMBER,
  type FrontMatterNumbering,
  type HeaderFooterSettings,
  type PageNumberFormat,
  type PageNumberPosition,
  type RunningHeadKind,
} from '@/shared/book'
import { HEADER_FOOTER_CONTROLS as C } from './controls'
import type { HeaderFooterControlKey } from './controls'
import { closeHeaderFooterDialog, openHeaderFooterDialog, useOpenDialog } from './dialog-state'
import { HeaderFooterPreview } from './HeaderFooterPreview'

const HEAD_OPTIONS: SelectOption[] = [
  { value: 'title', label: 'Book title' },
  { value: 'author', label: 'Author name' },
  { value: 'chapter', label: 'Chapter title' },
  { value: 'custom', label: 'Custom text' },
  { value: 'none', label: 'Nothing' },
]
const POSITION_OPTIONS: SelectOption[] = [
  { value: 'footer-centre', label: 'Bottom, centred' },
  { value: 'footer-outside', label: 'Bottom, outside corner' },
  { value: 'header-outside', label: 'Top, outside corner' },
  { value: 'none', label: 'No page numbers' },
]
const FORMAT_OPTIONS: SelectOption[] = [
  { value: 'arabic', label: '1, 2, 3' },
  { value: 'lower-roman', label: 'i, ii, iii' },
]
const FRONT_OPTIONS: SelectOption[] = [
  { value: 'none', label: 'No numbers' },
  { value: 'roman', label: 'i, ii, iii' },
]

/** Opens when the toolbar button, a double-click on a header / footer, or `openHeaderFooterDialog()` asks. */
export function HeaderFooterDialog() {
  const open = useOpenDialog() === 'settings'
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && closeHeaderFooterDialog()}
      title="Headers & page numbers"
      description="Shown in the margins of every page. They are not part of your text, so they never take part in find, selection or page breaks."
      className="sm:max-w-2xl"
      footer={
        <Tooltip>
          <Button variant="primary" data-control-id={C.done.id} onClick={closeHeaderFooterDialog}>
            {C.done.label}
          </Button>
        </Tooltip>
      }
    >
      {open ? <HeaderFooterForm /> : null}
    </Dialog>
  )
}

function HeaderFooterForm() {
  const settings = useStore((s) => s.book.headerFooter)
  const trimSize = useStore((s) => s.book.trimSize)
  const margins = useStore((s) => s.book.margins)
  const title = useStore((s) => s.project.title) ?? ''
  const author = useStore((s) => s.project.author)
  const projectOpen = useStore((s) => s.project.path !== null)
  const set = useStore((s) => s.bookActions.setHeaderFooter)
  const formId = useId()
  const [startText, setStartText] = useState(() => String(settings.pageNumber.start))

  const update = (patch: (h: HeaderFooterSettings) => HeaderFooterSettings) => set((h) => patch(h))
  const startValid = /^\d{1,4}$/.test(startText.trim()) && Number(startText) <= MAX_START_NUMBER

  const field = (key: HeaderFooterControlKey, control: (p: { id: string; 'data-control-id': string }) => ReactElement, hint?: string) => {
    const id = `${formId}-${key}`
    return (
      <div className="flex min-w-0 flex-col gap-1">
        <label htmlFor={id} className="text-ui-xs font-medium text-text-muted">
          {C[key].label}
        </label>
        <Tooltip>{control({ id, 'data-control-id': C[key].id })}</Tooltip>
        {hint ? <p className="m-0 text-ui-xs text-text-muted">{hint}</p> : null}
      </div>
    )
  }
  const check = (key: HeaderFooterControlKey, checked: boolean, onChange: (v: boolean) => void) => (
    <Tooltip>
      <Checkbox label={C[key].label} checked={checked} onCheckedChange={onChange} data-control-id={C[key].id} />
    </Tooltip>
  )
  const head = (side: 'verso' | 'recto') => {
    const kindKey = side
    const textKey = side === 'verso' ? 'versoText' : 'rectoText'
    const h = settings[side]
    const missing =
      (h.kind === 'title' && !title.trim()) || (h.kind === 'author' && !author.trim())
        ? h.kind === 'title'
          ? 'The book title is empty: choose Book details.'
          : 'The author name is empty: choose Book details.'
        : undefined
    return (
      <>
        {field(
          kindKey,
          (p) => (
            <Select
              {...p}
              value={h.kind}
              options={HEAD_OPTIONS}
              onChange={(e) => update((x) => ({ ...x, [side]: { ...x[side], kind: e.target.value as RunningHeadKind } }))}
            />
          ),
          missing,
        )}
        {h.kind === 'custom'
          ? field(textKey, (p) => (
              <TextInput
                {...p}
                value={h.text}
                maxLength={200}
                onChange={(e) => update((x) => ({ ...x, [side]: { ...x[side], text: e.target.value } }))}
              />
            ))
          : null}
      </>
    )
  }

  const pn = settings.pageNumber
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
        <div className="flex flex-col gap-3">{head('verso')}</div>
        <div className="flex flex-col gap-3">{head('recto')}</div>
        {field('numberPosition', (p) => (
          <Select
            {...p}
            value={pn.position}
            options={POSITION_OPTIONS}
            onChange={(e) => update((x) => ({ ...x, pageNumber: { ...x.pageNumber, position: e.target.value as PageNumberPosition } }))}
          />
        ))}
        {field('numberFormat', (p) => (
          <Select
            {...p}
            value={pn.format}
            options={FORMAT_OPTIONS}
            disabled={pn.position === 'none'}
            onChange={(e) => update((x) => ({ ...x, pageNumber: { ...x.pageNumber, format: e.target.value as PageNumberFormat } }))}
          />
        ))}
        {field(
          'numberStart',
          (p) => (
            <TextInput
              {...p}
              inputMode="numeric"
              value={startText}
              disabled={pn.position === 'none'}
              aria-invalid={!startValid || undefined}
              className={cn('max-w-28')}
              onChange={(e) => {
                setStartText(e.target.value)
                const t = e.target.value.trim()
                if (/^\d{1,4}$/.test(t)) update((x) => ({ ...x, pageNumber: { ...x.pageNumber, start: Math.min(MAX_START_NUMBER, Number(t)) } }))
              }}
              onBlur={() => setStartText(String(useStore.getState().book.headerFooter.pageNumber.start))}
            />
          ),
          startValid ? undefined : `Use a whole number from 0 to ${MAX_START_NUMBER}.`,
        )}
        {field('frontMatter', (p) => (
          <Select
            {...p}
            value={settings.frontMatter}
            options={FRONT_OPTIONS}
            disabled={pn.position === 'none'}
            onChange={(e) => update((x) => ({ ...x, frontMatter: e.target.value as FrontMatterNumbering }))}
          />
        ), 'Pages before the first chapter.')}
      </div>

      <fieldset className="m-0 flex flex-col gap-0.5 border-0 p-0">
        <legend className="mb-1 p-0 text-ui-xs font-medium text-text-muted">Options</legend>
        {check('restart', settings.restartAtFirstChapter, (v) => update((x) => ({ ...x, restartAtFirstChapter: v })))}
        {check('suppressHeader', settings.suppressHeaderOnOpening, (v) => update((x) => ({ ...x, suppressHeaderOnOpening: v })))}
        {check('suppressNumber', settings.suppressNumberOnOpening, (v) => update((x) => ({ ...x, suppressNumberOnOpening: v })))}
        {check('suppressBlank', settings.suppressOnBlank, (v) => update((x) => ({ ...x, suppressOnBlank: v })))}
      </fieldset>

      <section aria-label="Preview" className="flex flex-col gap-2">
        <HeaderFooterPreview
          settings={settings}
          title={title.trim() || 'Book Title'}
          author={author.trim() || 'Author Name'}
          chapterTitle="Chapter Title"
          trimSize={trimSize}
          margins={margins}
        />
      </section>

      <div className="flex flex-wrap items-center gap-3">
        <Tooltip>
          <Button data-control-id={C.details.id} disabled={!projectOpen} onClick={() => openHeaderFooterDialog('details')}>
            {C.details.label}
          </Button>
        </Tooltip>
        <p className="m-0 min-w-0 flex-1 text-ui-xs text-text-muted">
          {projectOpen ? (
            <>
              <strong className="font-medium text-text">{title || 'Untitled'}</strong>
              {author.trim() ? ` by ${author.trim()}` : ' (no author yet)'}
            </>
          ) : (
            'Save the project to give the book a title and author for the page headers.'
          )}
        </p>
      </div>
    </div>
  )
}
