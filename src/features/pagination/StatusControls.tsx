import { useStore } from '@/shared/store'
import { IconButton, Select, ToggleButton, Tooltip } from '@/shared/ui'
import { PAGINATION_CONTROLS as C } from './controls'
import { MAX_SCALE, MIN_SCALE, stepZoom, ZOOM_STEPS } from './placement'

/** "Pages 12–13 of 384" (or "Page 1 of 384") for the spread in view. */
export function pageIndicatorText(first: number, last: number, count: number): string {
  if (count <= 0) return ''
  const a = Math.min(first, count - 1) + 1
  const b = Math.min(last, count - 1) + 1
  return a === b ? `Page ${a} of ${count}` : `Pages ${a}–${b} of ${count}`
}

/**
 * Status-bar page indicator. Plain text (not a control), polite live region off: it changes on scroll.
 * In a narrow status bar (`statusbar` container) it shortens to "12 / 384", then hides.
 */
export function PageIndicator() {
  const count = useStore((s) => s.layout.pageCount)
  const first = useStore((s) => s.layout.visibleSpread.first)
  const last = useStore((s) => s.layout.visibleSpread.last)
  if (count <= 0) return null
  const full = pageIndicatorText(first, last, count)
  return (
    <span className="shrink-0 tabular-nums whitespace-nowrap @max-[560px]/statusbar:hidden" title={full}>
      <span className="@max-[760px]/statusbar:hidden" data-testid="page-indicator">
        {full}
      </span>
      <span className="@min-[760px]/statusbar:hidden" aria-hidden="true">
        {`${Math.min(first, count - 1) + 1} / ${count}`}
      </span>
    </span>
  )
}

const ZOOM_OPTIONS = [
  { value: 'fit-spread', label: 'Fit spread' },
  { value: 'fit-width', label: 'Fit width' },
  ...ZOOM_STEPS.map((z) => ({ value: String(z), label: `${z}%` })),
]

const MinusIcon = () => (
  <svg aria-hidden="true" viewBox="0 0 16 16" className="size-4">
    <path d="M3.5 8h9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
)
const PlusIcon = () => (
  <svg aria-hidden="true" viewBox="0 0 16 16" className="size-4">
    <path d="M3.5 8h9M8 3.5v9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
)
const SpreadIcon = () => (
  <svg aria-hidden="true" viewBox="0 0 16 16" className="size-4">
    <path d="M1.75 3.25h5.5v9.5h-5.5zM8.75 3.25h5.5v9.5h-5.5z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
  </svg>
)

/** Zoom out, zoom choice (fit spread / fit width / percentages), zoom in; and the spread toggle. */
export function ZoomControls() {
  const zoom = useStore((s) => s.layout.zoom)
  const scale = useStore((s) => s.layout.scale)
  const setZoom = useStore((s) => s.layoutActions.setZoom)
  const view = useStore((s) => s.book.view)
  const setView = useStore((s) => s.bookActions.setView)
  const effective = useStore((s) => s.layout.effectiveView)

  const value = zoom.mode === 'percent' ? String(zoom.percent) : zoom.mode
  const options =
    zoom.mode === 'percent' && !ZOOM_STEPS.includes(zoom.percent as (typeof ZOOM_STEPS)[number])
      ? [...ZOOM_OPTIONS, { value, label: `${zoom.percent}%` }]
      : ZOOM_OPTIONS
  // In a fit mode the select shows the mode; the actual percentage is announced in its label.
  const pct = Math.round(scale * 100)

  return (
    // Narrow status bar (`statusbar` container): only the zoom menu stays (it has every zoom level and the
    // fit modes; the spread toggle is also in the View tab and menu).
    <span className="inline-flex shrink-0 items-center gap-1" role="group" aria-label="Page view">
      <Tooltip>
        <ToggleButton
          label={C.spreadView.label}
          data-control-id={C.spreadView.id}
          pressed={view === 'spread'}
          className="@max-[640px]/statusbar:hidden"
          onPressedChange={(on) => setView(on ? 'spread' : 'single')}
          data-fallback={effective !== view || undefined}
        >
          <SpreadIcon />
        </ToggleButton>
      </Tooltip>
      <Tooltip>
        <IconButton
          label={C.zoomOut.label}
          data-control-id={C.zoomOut.id}
          className="@max-[640px]/statusbar:hidden"
          disabled={scale <= MIN_SCALE + 0.001 || pct <= ZOOM_STEPS[0]}
          onClick={() => setZoom({ mode: 'percent', percent: stepZoom(scale, -1) })}
        >
          <MinusIcon />
        </IconButton>
      </Tooltip>
      <Tooltip>
        <Select
          aria-label={`${C.zoom.label} (${pct}%)`}
          data-control-id={C.zoom.id}
          wrapperClassName="w-32"
          className="min-h-control text-ui-xs"
          options={options}
          value={value}
          onChange={(e) => {
            const v = e.target.value
            if (v === 'fit-spread' || v === 'fit-width') setZoom({ mode: v })
            else setZoom({ mode: 'percent', percent: Number(v) })
          }}
        />
      </Tooltip>
      <Tooltip>
        <IconButton
          label={C.zoomIn.label}
          data-control-id={C.zoomIn.id}
          className="@max-[640px]/statusbar:hidden"
          disabled={scale >= MAX_SCALE - 0.001 || pct >= ZOOM_STEPS[ZOOM_STEPS.length - 1]}
          onClick={() => setZoom({ mode: 'percent', percent: stepZoom(scale, 1) })}
        >
          <PlusIcon />
        </IconButton>
      </Tooltip>
    </span>
  )
}
