import { useStore } from '@/shared/store'
import { Button, cn, focusRing, Tooltip } from '@/shared/ui'
import type { Correction, CorrectionKind } from '../harness/output-tools'
import { CHANGED_REASON, EARLIER_SESSION_REASON, fixAvailability, isFromEarlierSession, locationLabel, locationSpoken } from './apply'
import { fixCorrection, getTutorSession, ignoreCorrection, jumpTo } from './chat'
import { TUTOR_CONTROLS as C } from './controls'
import { CheckIcon } from './icons'

const KIND_LABEL: Record<CorrectionKind, string> = {
  spelling: 'Spelling',
  grammar: 'Grammar',
  punctuation: 'Punctuation',
  style: 'Style',
  format: 'Formatting',
}

/** Not `disabled`: an unavailable Fix stays focusable, so its tooltip (and the reason) reaches the keyboard. */
const offClass = 'aria-disabled:cursor-not-allowed aria-disabled:opacity-60'

function CorrectionItem({ c }: { c: Correction }) {
  // Re-checked on every edit and every re-write change: Fix follows the paragraph as it is now.
  useStore((s) => s.editor.docVersion)
  useStore((s) => s.rewrite.openId)
  useStore((s) => s.rewrite.rewrites)
  const session = getTutorSession()
  const fix = session ? fixAvailability(session.idx, c) : { ok: false as const, reason: isFromEarlierSession(c) ? EARLIER_SESSION_REASON : CHANGED_REASON }
  const reason = !fix.ok ? fix.reason : ''
  const where = locationLabel(c.location)
  const open = c.state === 'open'
  return (
    <li
      className={cn('flex flex-col gap-1.5 rounded-panel border border-border bg-surface p-2.5', !open && 'bg-surface-raised')}
      data-correction-id={c.id}
      data-state={c.state}
    >
      <div className="flex items-center gap-2">
        <span className="text-ui-xs font-semibold uppercase tracking-wide text-text-muted">{KIND_LABEL[c.kind]}</span>
        <span className="flex-1" />
        <Tooltip copy={{ title: `Go to ${locationSpoken(c.location)}`, description: C.correctionJump.description }} side="left">
          <button
            type="button"
            data-control-id={C.correctionJump.id}
            aria-label={`Go to ${locationSpoken(c.location)}`}
            onClick={() => jumpTo(c.id)}
            className={cn('-my-1 min-h-control rounded-control px-1.5 text-ui-xs font-medium text-accent underline-offset-2 hover:underline', focusRing)}
          >
            {where}
          </button>
        </Tooltip>
      </div>
      <p className="text-ui-sm text-text">
        <del className="text-text-muted decoration-danger decoration-2">{c.original}</del>
        <span aria-hidden="true" className="px-1.5 text-text-muted">
          →
        </span>
        <span className="sr-only"> becomes </span>
        <ins className="font-semibold text-text no-underline">{c.suggestion || '(delete)'}</ins>
      </p>
      <p className="text-ui-sm text-text-muted">{c.explanation}</p>
      {c.state === 'applied' ? (
        <p className="flex items-center gap-1 text-ui-xs font-medium text-success" role="status">
          <CheckIcon className="size-3.5" /> Fixed
        </p>
      ) : c.state === 'ignored' ? (
        <p className="text-ui-xs font-medium text-text-muted" role="status">
          Ignored
        </p>
      ) : (
        <>
          {reason ? (
            <p className="text-ui-xs text-text-muted" data-testid="correction-reason">
              {reason}
            </p>
          ) : null}
          {open || c.state === 'changed' ? (
            <div className="flex gap-1.5">
              <Tooltip copy={{ title: C.correctionFix.label, description: reason ? `${C.correctionFix.description} Not now: ${reason}` : C.correctionFix.description }}>
                <Button
                  variant="primary"
                  data-control-id={C.correctionFix.id}
                  aria-disabled={fix.ok ? undefined : true}
                  onClick={() => fix.ok && fixCorrection(c.id)}
                  className={cn('px-3', offClass)}
                >
                  Fix
                </Button>
              </Tooltip>
              {open ? (
                <Tooltip controlId={C.correctionIgnore.id}>
                  <Button variant="ghost" data-control-id={C.correctionIgnore.id} onClick={() => ignoreCorrection(c.id)}>
                    Ignore
                  </Button>
                </Tooltip>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </li>
  )
}

/** A reply's corrections (list_corrections): where, the fix, why; Fix, Ignore, and the jump to the text. */
export function CorrectionList({ items }: { items: Correction[] }) {
  const open = items.filter((c) => c.state === 'open').length
  return (
    <section aria-label="Corrections" className="flex flex-col gap-2">
      <h3 className="text-ui-xs font-semibold text-text-muted">
        {items.length === 1 ? '1 correction' : `${items.length} corrections`}
        {open !== items.length ? ` · ${open} to review` : ''}
      </h3>
      <ul className="flex flex-col gap-2">
        {items.map((c) => (
          <CorrectionItem key={c.id} c={c} />
        ))}
      </ul>
    </section>
  )
}
