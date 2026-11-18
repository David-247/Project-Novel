import { useMemo, useSyncExternalStore } from 'react'
import { useStore, type PageInfo } from '@/shared/store'
import { Button, Checkbox, Dialog, Tooltip } from '@/shared/ui'
import { getEditor } from '../controller'
import { WORD_COUNT_CONTROLS as C } from './controls'
import { flushWordCount } from './publisher'

// ---- Number text ---------------------------------------------------------------------------------

let numberFormat: Intl.NumberFormat | null = null
/** "98,412" in the reader's locale. */
export const formatCount = (n: number): string => (numberFormat ??= new Intl.NumberFormat()).format(n)

/** Word's status bar text: "98,412 words", or "1,203 of 98,412 words" with a selection. */
export function wordCountText(total: number, selected: number | null): string {
  const unit = (n: number) => (n === 1 ? 'word' : 'words')
  if (selected === null) return `${formatCount(total)} ${unit(total)}`
  return `${formatCount(selected)} of ${formatCount(total)} ${unit(total)}`
}

/** The short form for a narrow status bar: "98,412 words", or "1,203/98,412" with a selection. */
export function wordCountShortText(total: number, selected: number | null): string {
  return selected === null ? wordCountText(total, null) : `${formatCount(selected)}/${formatCount(total)}`
}

// ---- Dialog open state (shared by the status bar, the command and the ribbon) --------------------

let dialogOpen = false
let returnFocusTo: HTMLElement | null = null
const listeners = new Set<() => void>()

function setDialogOpen(next: boolean) {
  if (next === dialogOpen) return
  if (next) {
    returnFocusTo = document.activeElement instanceof HTMLElement ? document.activeElement : null
    // Show the counts of the document and selection as they are now (not ~150 ms old).
    flushWordCount()
  }
  dialogOpen = next
  listeners.forEach((l) => l())
}

/** Review ▸ Word Count… (Mod-Shift-g, the status bar count, the ribbon). */
export function openWordCount(): void {
  setDialogOpen(true)
}

export function closeWordCount(): void {
  setDialogOpen(false)
}

export function isWordCountOpen(): boolean {
  return dialogOpen
}

function useDialogOpen(): boolean {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => dialogOpen,
    () => dialogOpen,
  )
}

/** Give the focus back where it was when the dialog opened: the manuscript through its view (keeps its selection). */
function giveFocusBack(e: Event) {
  e.preventDefault()
  const target = returnFocusTo
  returnFocusTo = null
  const ed = getEditor()
  if (ed && (!target || !target.isConnected || target === document.body || target === ed.view.dom || ed.view.dom.contains(target))) ed.view.focus()
  else target?.focus()
}

// ---- Lines (the pagination slice's, wired by the composition root) -------------------------------

type LineSource = (range?: { from: number; to: number }) => number | null
let lineSource: LineSource | null = null

/** Where the dialog's "Lines" come from (the pagination slice's `countLines`). Returns unset. */
export function setWordCountLineSource(source: LineSource | null): () => void {
  lineSource = source
  return () => {
    if (lineSource === source) lineSource = null
  }
}

/** Pages holding some of `[from, to)` (blank pages left out). */
function pagesInRange(pages: readonly PageInfo[], from: number, to: number): number {
  let n = 0
  for (const p of pages) if (!p.isBlank && p.from < to && p.to > from) n++
  return n
}

// ---- Status bar -----------------------------------------------------------------------------------

/**
 * Status-bar word count, as in Word: "98,412 words", or "1,203 of 98,412 words" with a selection.
 * A button that opens the Word Count dialog. No live region (it changes on every keystroke). In a
 * narrow status bar (`statusbar` container) it shortens ("1,203/98,412"), then hides, like the page
 * indicator. Its accessible name is the visible text plus a hidden ". Word count".
 */
export function WordCountIndicator() {
  const ready = useStore((s) => s.wordCount.ready)
  const total = useStore((s) => s.wordCount.document.total.words)
  const selected = useStore((s) => s.wordCount.selection?.total.words ?? null)
  if (!ready) return null
  return (
    <Tooltip>
      <Button
        variant="ghost"
        className="relative shrink-0 tabular-nums whitespace-nowrap px-2 text-ui-xs font-normal @max-[640px]/statusbar:hidden"
        data-control-id={C.indicator.id}
        aria-haspopup="dialog"
        onClick={openWordCount}
      >
        <span className="@max-[860px]/statusbar:hidden" data-testid="word-count">
          {wordCountText(total, selected)}
        </span>
        <span className="@min-[860px]/statusbar:hidden" data-testid="word-count-short">
          {wordCountShortText(total, selected)}
        </span>
        <span className="sr-only">{`. ${C.indicator.label}`}</span>
      </Button>
    </Tooltip>
  )
}

// ---- Dialog ---------------------------------------------------------------------------------------

/**
 * Review ▸ Word Count…: Word's statistics (pages, words, characters without and with spaces,
 * paragraphs, lines) of the selection when there is one, else of the book, and "Include footnotes".
 * Live: the counts follow edits while it is open (the store's `wordCount`).
 */
export function WordCountDialog() {
  const open = useDialogOpen()
  return <WordCountDialogView open={open} onOpenChange={setDialogOpen} />
}

function WordCountDialogView({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const include = useStore((s) => s.wordCount.includeFootnotes)
  const document = useStore((s) => s.wordCount.document)
  const selection = useStore((s) => s.wordCount.selection)
  const pages = useStore((s) => s.layout.pages)
  const layoutVersion = useStore((s) => s.layout.layoutVersion)
  const docVersion = useStore((s) => s.wordCount.docVersion)
  const setInclude = useStore((s) => s.wordCountActions.setIncludeFootnotes)
  const counts = selection ?? document
  const range = selection ? { from: selection.from, to: selection.to } : null
  const pageCount = range ? pagesInRange(pages, range.from, range.to) : pages.length
  const lines = useMemo(
    () => (open ? (lineSource?.(range ?? undefined) ?? null) : null),
    // Recounted when the layout, the text or the selection changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [open, layoutVersion, docVersion, range?.from, range?.to],
  )
  const rows: [string, number | null][] = [
    ['Pages', pages.length ? pageCount : null],
    ['Words', counts.total.words],
    ['Characters (no spaces)', counts.total.charactersNoSpaces],
    ['Characters (with spaces)', counts.total.charactersWithSpaces],
    ['Paragraphs', counts.total.paragraphs],
    ['Lines', lines],
  ]
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Word Count"
      description={selection ? 'Counts of the selected text.' : 'Counts of the whole book, with every tracked change accepted.'}
      closeControlId={C.close.id}
      onCloseAutoFocus={giveFocusBack}
      footer={
        <Tooltip controlId={C.done.id}>
          <Button variant="primary" data-control-id={C.done.id} onClick={() => onOpenChange(false)}>
            {C.done.label}
          </Button>
        </Tooltip>
      }
    >
      <div className="grid gap-4">
        <table className="w-full text-ui" data-testid="word-count-stats">
          <caption className="sr-only">Statistics</caption>
          <tbody>
            {rows.map(([label, value]) => (
              <tr key={label} className="border-b border-border last:border-0">
                <th scope="row" className="py-1.5 pr-4 text-left font-normal text-text-muted">
                  {label}
                </th>
                <td className="py-1.5 text-right tabular-nums" data-stat={label}>
                  {value === null ? '–' : formatCount(value)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <Tooltip controlId={C.includeFootnotes.id}>
          <Checkbox data-control-id={C.includeFootnotes.id} label={C.includeFootnotes.label} checked={include} onCheckedChange={setInclude} />
        </Tooltip>
      </div>
    </Dialog>
  )
}
