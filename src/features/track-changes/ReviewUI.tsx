import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { useStore } from '@/shared/store'
import { ANCHORED_GUTTER, Button, placeAnchored, StatusText, Tooltip } from '@/shared/ui'
import { isTracking } from './commands'
import { TRACK_CHANGES_CONTROLS } from './controls'
import { describeChange, popoverAllowed, relativeDate, type ChangeDetails } from './popover-actions'
import { nextChange, resolveChange } from './review-actions'
import { closeChangePopover, getReviewView, useChangePopover, useChangeSummary, type ChangePopoverState } from './review-state'

const C = TRACK_CHANGES_CONTROLS

/**
 * The change popover: author, relative date, kind and a preview of one tracked change, with Accept
 * and Reject. Anchored under the change (the footnote editor's placement), portalled to the body.
 * Opened by a click or tap on a change, or Show Change Details (Alt+Enter) at the caret, which puts
 * the focus on Accept. Escape returns to the text. Render it once (the composition root).
 */
export function ChangePopover() {
  const state = useChangePopover()
  const view = useStore((s) => s.trackChanges.markupView)
  useEffect(() => {
    if (state && !popoverAllowed()) closeChangePopover()
  }, [state, view])
  if (!state || typeof document === 'undefined') return null
  return createPortal(<PopoverBody key={state.seq} state={state} />, document.body)
}

function PopoverBody({ state }: { state: ChangePopoverState }) {
  const rootRef = useRef<HTMLDivElement>(null)
  const acceptRef = useRef<HTMLButtonElement>(null)
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null)
  const [details, setDetails] = useState<ChangeDetails | null>(() => {
    const v = getReviewView()
    return v ? describeChange(v.state.doc, state.id) : null
  })

  const back = useCallback(() => {
    closeChangePopover()
    getReviewView()?.focus()
  }, [])

  const reposition = useCallback(() => {
    const root = rootRef.current
    const v = getReviewView()
    if (!root || !v) return
    let r: { left: number; top: number; bottom: number }
    try {
      r = v.coordsAtPos(Math.min(state.anchor, v.state.doc.content.size))
    } catch {
      return
    }
    const next = placeAnchored(r, { width: root.offsetWidth, height: root.offsetHeight })
    setPlace((p) => (p && p.left === next.left && p.top === next.top ? p : next))
  }, [state.anchor])

  useLayoutEffect(() => {
    if (!details) {
      closeChangePopover()
      return
    }
    reposition()
    if (state.focus) acceptRef.current?.focus()
    const onMove = () => reposition()
    window.addEventListener('scroll', onMove, true)
    window.addEventListener('resize', onMove)
    const unstore = useStore.subscribe((s, p) => {
      if (s.layout !== p.layout) requestAnimationFrame(reposition)
      if (s.editor !== p.editor) {
        // The document changed under the popover (undo, another edit): follow or close.
        const v = getReviewView()
        const d = v ? describeChange(v.state.doc, state.id) : null
        if (!d) closeChangePopover()
        else setDetails(d)
      }
    })
    return () => {
      window.removeEventListener('scroll', onMove, true)
      window.removeEventListener('resize', onMove)
      unstore()
    }
    // Mount only: a new open remounts (key = seq).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (!details) return null
  const { change } = details

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.defaultPrevented) return
    if (e.key === 'Escape') {
      e.preventDefault()
      back()
      return
    }
    // Tab / Shift-Tab cycle between Accept and Reject (the popover is portalled: never tab out of it).
    if (e.key !== 'Tab') return
    e.preventDefault()
    const order = Array.from(rootRef.current?.querySelectorAll<HTMLElement>('button') ?? [])
    const i = order.indexOf(document.activeElement as HTMLElement)
    order[(i + (e.shiftKey ? -1 : 1) + order.length) % order.length]?.focus()
  }

  const when = relativeDate(change.date)
  return (
    <div
      ref={rootRef}
      role="group"
      aria-label={`${details.kind} by ${change.author || 'Unknown author'}`}
      data-testid="change-popover"
      data-change-id={change.id}
      className="fixed z-40 w-[min(22rem,calc(100vw-1rem))] rounded-panel border border-border bg-surface-raised p-3 text-text shadow-raised"
      style={place ? { left: place.left, top: place.top } : { left: ANCHORED_GUTTER, top: ANCHORED_GUTTER, opacity: 0 }}
      // A press on the popover keeps the focus where it is (the caret in the text, or a button):
      // WebKit blurs to nothing on a press on a button.
      onMouseDown={(e) => e.preventDefault()}
      onKeyDown={onKeyDown}
      onBlur={(e) => {
        const next = e.relatedTarget as Node | null
        if (next && rootRef.current?.contains(next)) return
        requestAnimationFrame(() => {
          if (rootRef.current && !rootRef.current.contains(document.activeElement) && document.activeElement !== getReviewView()?.dom) closeChangePopover()
        })
      }}
    >
      <div className="flex items-baseline gap-2">
        <span
          aria-hidden="true"
          className={`inline-block size-2.5 shrink-0 self-center rounded-full border border-border ${details.color ? '' : 'bg-current text-text-muted'}`}
          style={details.color ? { background: details.color } : undefined}
        />
        <span className="truncate text-ui-sm font-semibold" data-testid="change-popover-author">
          {change.author || 'Unknown author'}
        </span>
        {when && (
          <time className="shrink-0 text-ui-xs text-text-muted" dateTime={change.date} title={new Date(change.date).toLocaleString()}>
            {when}
          </time>
        )}
      </div>
      <p className="mt-1 text-ui-sm" data-testid="change-popover-kind">
        {details.kind}
        {details.preview && (
          <>
            {': '}
            <q className="break-words text-text-muted" data-testid="change-popover-preview">
              {details.preview}
            </q>
          </>
        )}
      </p>
      <div className="mt-3 flex items-center gap-2">
        <Tooltip controlId={C.popoverAccept.id}>
          <Button ref={acceptRef} variant="primary" size="lg" data-control-id={C.popoverAccept.id} onClick={() => resolveChange(change.id, 'accept')}>
            {C.popoverAccept.label}
          </Button>
        </Tooltip>
        <Tooltip controlId={C.popoverReject.id}>
          <Button size="lg" data-control-id={C.popoverReject.id} onClick={() => resolveChange(change.id, 'reject')}>
            {C.popoverReject.label}
          </Button>
        </Tooltip>
        <span className="flex-1 text-right text-ui-xs text-text-muted">Esc returns to the text</span>
      </div>
    </div>
  )
}

/**
 * Status bar: "N changes" while Track Changes is on or the book has changes. A button: it goes to the
 * next change. Put it next to TrackChangesNotice.
 */
export function ChangesIndicator() {
  const { count } = useChangeSummary()
  const on = useStore((s) => isTracking(s))
  if (!on && count === 0) return null
  if (count === 0)
    return (
      <StatusText tone="muted" data-testid="changes-indicator">
        No changes
      </StatusText>
    )
  const text = `${count.toLocaleString()} ${count === 1 ? 'change' : 'changes'}`
  return (
    <Tooltip controlId={C.changes.id}>
      <Button
        variant="ghost"
        data-control-id={C.changes.id}
        data-testid="changes-indicator"
        className="tabular-nums whitespace-nowrap"
        aria-label={`${text}. Go to the next change`}
        onClick={() => void nextChange()}
      >
        {text}
      </Button>
    </Tooltip>
  )
}
