import { useEffect, useLayoutEffect, useRef, type KeyboardEvent } from 'react'
import { cn, controlBase, IconButton, Tooltip } from '@/shared/ui'
import { removeChip, send, setDraft, stop, useTutorChat, type Chip } from './chat'
import { TUTOR_CONTROLS as C } from './controls'
import { ContextMenuPlus } from './ContextMenuPlus'
import { BookIcon, ChapterIcon, CloseIcon, PageIcon, SelectionIcon, SendIcon, StopIcon } from './icons'
import { ModelPicker } from './ModelPicker'

const formatCount = (n: number) => new Intl.NumberFormat().format(n)
const MAX_ROWS_PX = 160
/** ➤ and Stop: round, filled with the accent (their own colours: IconButton's muted text would compete). */
const roundAction = cn(controlBase, 'rounded-full px-1.5')

function ChipIcon({ chip }: { chip: Chip }) {
  switch (chip.attachment.kind) {
    case 'page':
      return <PageIcon />
    case 'chapter':
      return <ChapterIcon />
    case 'selection':
      return <SelectionIcon />
    case 'manuscript':
      return <BookIcon />
  }
}

function ChipView({ chip, onRemoved }: { chip: Chip; onRemoved: () => void }) {
  const remove = () => {
    removeChip(chip.id)
    onRemoved()
  }
  const words = `${formatCount(chip.words)} ${chip.words === 1 ? 'word' : 'words'}`
  return (
    <li className="inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-surface-raised py-0 pl-2.5 pr-0 text-ui-xs text-text" data-testid="tutor-chip">
      <span className="text-text-muted">
        <ChipIcon chip={chip} />
      </span>
      <span className="truncate font-medium">{chip.label}</span>
      <span className="shrink-0 tabular-nums text-text-muted">· {words}</span>
      <Tooltip copy={{ title: `Remove ${chip.label}`, description: C.chipRemove.description }} side="top">
        <IconButton
          label={`Remove ${chip.label}`}
          data-control-id={C.chipRemove.id}
          className="rounded-full"
          onClick={remove}
          onKeyDown={(e) => {
            if (e.key === 'Backspace' || e.key === 'Delete') {
              e.preventDefault()
              remove()
            }
          }}
        >
          <CloseIcon className="size-3.5" />
        </IconButton>
      </Tooltip>
    </li>
  )
}

/**
 * The composer (Copilot's chat box): the attachment chips, the question, + to attach, ➤ to send (Stop
 * while a reply streams), and the model picker below. Enter sends, Shift+Enter adds a line, Backspace
 * in an empty box removes the last chip.
 */
export function Composer() {
  const draft = useTutorChat((s) => s.draft)
  const chips = useTutorChat((s) => s.chips)
  const busy = useTutorChat((s) => s.busy)
  const focusSeq = useTutorChat((s) => s.focusSeq)
  const input = useRef<HTMLTextAreaElement>(null)

  // The panel or a command asked for the focus ("Ask the Tutor About This", opening the panel).
  useEffect(() => {
    if (focusSeq === 0) return
    const id = requestAnimationFrame(() => input.current?.focus())
    return () => cancelAnimationFrame(id)
  }, [focusSeq])

  // Grow with the text, up to a few lines.
  useLayoutEffect(() => {
    const el = input.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_ROWS_PX)}px`
  }, [draft])

  const canSend = !busy && draft.trim().length > 0
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      if (canSend) void send()
      return
    }
    if (e.key === 'Backspace' && !draft && chips.length) {
      e.preventDefault()
      removeChip(chips[chips.length - 1].id)
    }
  }

  return (
    <div className="shrink-0 border-t border-border bg-surface-raised px-3 pt-2.5 pb-1.5" data-testid="tutor-composer">
      <div
        className={cn(
          'flex flex-col rounded-panel border border-border-control bg-surface shadow-sm transition-colors',
          'focus-within:border-accent focus-within:ring-1 focus-within:ring-accent',
        )}
      >
        {chips.length ? (
          <ul className="flex flex-wrap gap-1 px-2 pt-2" aria-label="Attachments">
            {chips.map((c) => (
              <ChipView key={c.id} chip={c} onRemoved={() => input.current?.focus()} />
            ))}
          </ul>
        ) : null}
        <Tooltip controlId={C.composer.id} side="top">
          <textarea
            ref={input}
            rows={1}
            data-control-id={C.composer.id}
            aria-label={C.composer.label}
            placeholder="Ask the tutor…"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            className="max-h-40 min-h-control-lg w-full resize-none bg-transparent px-3 pt-2.5 pb-1 text-ui text-text outline-hidden placeholder:text-text-muted"
          />
        </Tooltip>
        <div className="flex items-center gap-1 px-1.5 pb-1.5">
          <ContextMenuPlus />
          <span className="flex-1" />
          {busy ? (
            <Tooltip controlId={C.stop.id} side="top">
              <button type="button" aria-label={C.stop.label} data-control-id={C.stop.id} onClick={() => void stop()} className={cn(roundAction, 'bg-accent text-accent-contrast hover:bg-accent-hover')}>
                <StopIcon />
              </button>
            </Tooltip>
          ) : (
            <Tooltip controlId={C.send.id} side="top">
              <button
                type="button"
                aria-label={C.send.label}
                data-control-id={C.send.id}
                aria-disabled={canSend ? undefined : true}
                onClick={() => canSend && void send()}
                className={cn(roundAction, canSend ? 'bg-accent text-accent-contrast hover:bg-accent-hover' : 'cursor-not-allowed bg-surface-hover text-text-muted')}
              >
                <SendIcon />
              </button>
            </Tooltip>
          )}
        </div>
      </div>
      <ModelPicker />
    </div>
  )
}
