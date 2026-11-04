import { useState } from 'react'
import type { Ref } from 'react'
import { resolveFootnoteOptions, writeFootnoteOptions, type FootnoteFormat, type FootnoteNumbering } from '@/shared/book'
import { useStore } from '@/shared/store'
import { Button, Checkbox, Dialog, Select, Tooltip } from '@/shared/ui'
import { FOOTNOTE_OPTION_CONTROLS as C } from './controls'

export interface FootnoteOptionsButtonProps {
  /** Props from an asChild parent (a toolbar item) land on the button. */
  [prop: string]: unknown
  ref?: Ref<HTMLButtonElement>
}

const NUMBERING: { value: FootnoteNumbering; label: string }[] = [
  { value: 'book', label: 'Continuous through the book' },
  { value: 'chapter', label: 'Restart in each chapter' },
]
const FORMATS: { value: FootnoteFormat; label: string }[] = [
  { value: 'arabic', label: '1, 2, 3' },
  { value: 'symbols', label: '*, †, ‡' },
]

/**
 * Toolbar button `footnote.options` and its "Footnote options" dialog: numbering scope, number
 * format and the separator rule. Changes apply at once (and persist in book.json through the book
 * slice); Done or Escape closes, focus returns to the button.
 */
export function FootnoteOptionsButton({ ref, ...forwarded }: FootnoteOptionsButtonProps) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Tooltip controlId={C.open.id} {...forwarded} ref={ref as Ref<HTMLElement>}>
        <Button variant="ghost" data-control-id={C.open.id} aria-haspopup="dialog" onClick={() => setOpen(true)}>
          {C.open.label}
        </Button>
      </Tooltip>
      <FootnoteOptionsDialog open={open} onOpenChange={setOpen} />
    </>
  )
}

export function FootnoteOptionsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const stored = useStore((s) => s.book.footnotes)
  const options = resolveFootnoteOptions(stored)
  const set = (patch: Parameters<typeof writeFootnoteOptions>[1]) =>
    useStore.getState().bookActions.setFootnotes((f) => writeFootnoteOptions(f, patch))
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Footnote options"
      description="How footnotes are numbered and set off at the bottom of the page."
      closeControlId={C.close.id}
      footer={
        <Tooltip controlId={C.done.id}>
          <Button variant="primary" data-control-id={C.done.id} onClick={() => onOpenChange(false)}>
            {C.done.label}
          </Button>
        </Tooltip>
      }
    >
      <div className="grid gap-3">
        <label className="grid gap-1">
          <span className="text-ui-sm font-medium">{C.numbering.label}</span>
          <Tooltip controlId={C.numbering.id}>
            <Select
              data-control-id={C.numbering.id}
              value={options.numbering}
              options={NUMBERING}
              onChange={(e) => set({ numbering: e.target.value as FootnoteNumbering })}
            />
          </Tooltip>
        </label>
        <label className="grid gap-1">
          <span className="text-ui-sm font-medium">{C.format.label}</span>
          <Tooltip controlId={C.format.id}>
            <Select
              data-control-id={C.format.id}
              value={options.format}
              options={FORMATS}
              onChange={(e) => set({ format: e.target.value as FootnoteFormat })}
            />
          </Tooltip>
        </label>
        <Tooltip controlId={C.separator.id}>
          <Checkbox
            data-control-id={C.separator.id}
            label={C.separator.label}
            checked={options.separator}
            onCheckedChange={(separator) => set({ separator })}
          />
        </Tooltip>
      </div>
    </Dialog>
  )
}
