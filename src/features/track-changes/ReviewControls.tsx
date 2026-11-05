import * as Menu from '@radix-ui/react-dropdown-menu'
import type { Ref } from 'react'
import { useStore } from '@/shared/store'
import type { MarkupView } from '@/shared/track-changes'
import { ariaKeyshortcuts, Button, cn, focusRing, StatusText, ToggleButton, Tooltip } from '@/shared/ui'
import { isTracking, setMarkupView, setTracking } from './commands'
import { MARKUP_VIEW_OPTIONS, markupViewLabel, TRACK_CHANGES_CONTROLS } from './controls'

export interface ReviewControlProps {
  /** Props from an asChild parent (a toolbar item) land on the button. */
  [prop: string]: unknown
  ref?: Ref<HTMLButtonElement>
}

function TrackIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" className="size-5">
      <path d="M3 5h8M3 9h6M3 13h4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M10.5 15.5l.6-2.6 5.6-5.6a1.4 1.4 0 012 2l-5.6 5.6-2.6.6z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  )
}

/**
 * Track Changes on / off (`review.track`, Mod-Shift-e): a toggle button, pressed while recording.
 * Wrap it in `ToolbarItem`.
 */
export function TrackChangesButton({ ref, ...forwarded }: ReviewControlProps) {
  const on = useStore((s) => isTracking(s))
  const meta = TRACK_CHANGES_CONTROLS.track
  return (
    <Tooltip controlId={meta.id} {...forwarded} ref={ref as Ref<HTMLElement>}>
      <ToggleButton
        label={meta.label}
        data-control-id={meta.id}
        aria-keyshortcuts={ariaKeyshortcuts(meta.shortcut)}
        pressed={on}
        onPressedChange={setTracking}
        className="gap-1.5"
      >
        <TrackIcon />
        <span className="hidden xl:inline">{meta.label}</span>
      </ToggleButton>
    </Tooltip>
  )
}

const itemClass = cn(
  'relative flex min-h-control-lg cursor-default select-none items-center gap-3 rounded-control py-1.5 pl-7 pr-2.5',
  'text-ui-sm data-[highlighted]:bg-surface-hover',
  focusRing,
)

/**
 * View ▸ Markup picker (`review.markup`): All Markup, Simple Markup, No Markup, Original. A Radix
 * dropdown with a radio group (arrows move, Enter picks, Escape closes). Wrap it in `ToolbarItem`.
 */
export function MarkupViewMenu({ ref, ...forwarded }: ReviewControlProps) {
  const view = useStore((s) => s.trackChanges.markupView)
  const meta = TRACK_CHANGES_CONTROLS.markup
  return (
    <Menu.Root modal={false}>
      <Tooltip controlId={meta.id} {...forwarded} ref={ref as Ref<HTMLElement>}>
        <Menu.Trigger asChild>
          <Button variant="ghost" data-control-id={meta.id} aria-label={`${meta.label}: ${markupViewLabel(view)}`} className="gap-2">
            <span className="whitespace-nowrap">{markupViewLabel(view)}</span>
            <svg aria-hidden="true" viewBox="0 0 16 16" className="size-4 text-text-muted">
              <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </Button>
        </Menu.Trigger>
      </Tooltip>
      <Menu.Portal>
        <Menu.Content
          align="start"
          sideOffset={6}
          collisionPadding={8}
          className="z-40 min-w-56 max-w-[calc(100vw-1rem)] rounded-control border border-border bg-surface-raised p-1 text-text shadow-raised"
        >
          <Menu.RadioGroup value={view} onValueChange={(v) => setMarkupView(v as MarkupView)} aria-label={meta.label}>
            {MARKUP_VIEW_OPTIONS.map((o) => (
              <Tooltip key={o.id} side="right" controlId={o.id}>
                <Menu.RadioItem value={o.value} data-control-id={o.id} className={itemClass}>
                  <Menu.ItemIndicator className="absolute left-2 inline-flex items-center">
                    <svg aria-hidden="true" viewBox="0 0 16 16" className="size-4">
                      <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </Menu.ItemIndicator>
                  <span className="flex-1">{o.label}</span>
                </Menu.RadioItem>
              </Tooltip>
            ))}
          </Menu.RadioGroup>
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  )
}

/**
 * Status-bar warning when an edit could not be recorded (it was applied untracked). Shown until
 * Track Changes is turned off or on again. Put it in the status bar.
 */
export function TrackChangesNotice() {
  const notice = useStore((s) => s.trackChanges.notice)
  if (!notice) return null
  return (
    <StatusText tone="warning" live role="status" data-testid="track-changes-notice" className="whitespace-normal">
      {notice}
    </StatusText>
  )
}
