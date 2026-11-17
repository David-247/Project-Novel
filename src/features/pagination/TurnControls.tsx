import { Tooltip } from '@/shared/ui'
import { PAGINATION_CONTROLS as C } from './controls'
import { goToEdgeSpread, spreadEdges, turnSpread } from './navigation'

const ChevronLeft = () => (
  <svg aria-hidden="true" viewBox="0 0 16 16" className="size-5">
    <path d="M10 3.5 5.5 8l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)
const ChevronRight = () => (
  <svg aria-hidden="true" viewBox="0 0 16 16" className="size-5">
    <path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

function TurnButton({ dir, disabled }: { dir: 1 | -1; disabled: boolean }) {
  const meta = dir > 0 ? C.nextSpread : C.previousSpread
  return (
    <Tooltip side={dir > 0 ? 'left' : 'right'}>
      <button
        type="button"
        className="nv-turn"
        data-control-id={meta.id}
        aria-label={meta.label}
        // Not `disabled`: the control stays focusable and shows its tooltip at the first / last spread.
        aria-disabled={disabled || undefined}
        // A press never takes the focus from the manuscript (the caret stays where it was).
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          if (!disabled) turnSpread(dir)
        }}
        onKeyDown={(e) => {
          // Home / End on a turn control: first / last spread.
          if (e.key === 'Home' || e.key === 'End') {
            e.preventDefault()
            goToEdgeSpread(e.key === 'End' ? 1 : -1)
          }
        }}
      >
        {dir > 0 ? <ChevronRight /> : <ChevronLeft />}
      </button>
    </Tooltip>
  )
}

/**
 * Book mode's page-turn controls: always visible (not hover-only), one in a lane on each side of the
 * spread, vertically centred in the window. At the first / last spread the control is marked
 * disabled (dimmed, aria-disabled) but stays reachable.
 */
export function TurnControls({ row, rowCount }: { row: number; rowCount: number }) {
  const { atFirst, atLast } = spreadEdges(row, rowCount)
  return (
    <>
      <div className="nv-turn-lane nv-turn-lane--prev">
        <TurnButton dir={-1} disabled={atFirst} />
      </div>
      <div className="nv-turn-lane nv-turn-lane--next">
        <TurnButton dir={1} disabled={atLast} />
      </div>
    </>
  )
}
