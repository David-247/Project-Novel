import { memo } from 'react'
import type { PageInfo } from '@/shared/store'
import { usePageSlots, type PageSlot, type PageSlotContext } from './extension-points'
import type { PageGeometry } from './geometry'
import type { Placement } from './placement'

export interface PageFramesProps {
  placement: Placement
  pages: readonly PageInfo[]
  geometry: PageGeometry
  /** Rows to render (inclusive); rows outside cost nothing. */
  firstRow: number
  lastRow: number
}

/**
 * The paper: one frame per page (virtualised to the rows near the viewport), with the header and
 * footer slot regions inside the top and bottom margins. Purely visual and behind the text layer;
 * colours come only from --page-bg, --page-fg, --page-shadow, --desk-bg and --spine-shadow.
 */
export const PageFrames = memo(function PageFrames({ placement, pages, geometry, firstRow, lastRow }: PageFramesProps) {
  const slots = usePageSlots()
  const frames = []
  const count = pages.length
  for (let row = Math.max(0, firstRow); row <= Math.min(lastRow, placement.rowCount - 1); row++) {
    const [a, b] = placement.pagesInRow(row)
    for (let i = a; i <= b; i++) {
      const page = pages[i] ?? (count === 0 && i === 0 ? EMPTY_PAGE : null)
      if (!page) continue
      frames.push(<PageFrame key={i} page={page} pageCount={Math.max(1, count)} placement={placement} geometry={geometry} slots={slots} />)
    }
  }
  return (
    <div className="nv-frames" aria-hidden="true">
      {frames}
    </div>
  )
})

const EMPTY_PAGE: PageInfo = { index: 0, side: 'recto', from: 0, to: 0, isBlank: false, startsBlockType: null, chapterIndex: -1 }

function PageFrame({
  page,
  pageCount,
  placement,
  geometry,
  slots,
}: {
  page: PageInfo
  pageCount: number
  placement: Placement
  geometry: PageGeometry
  slots: readonly PageSlot[]
}) {
  const f = placement.frame(page.index)
  const c = placement.content(page.index)
  const header = slots.filter((s) => s.region === 'header')
  const footer = slots.filter((s) => s.region === 'footer')
  const ctx = (height: number): PageSlotContext => ({ page, pageCount, geometry, width: geometry.contentWidth, height })
  return (
    <div
      className={placement.view === 'spread' ? `nv-page nv-page--${page.side}` : 'nv-page'}
      data-page-index={page.index}
      data-side={page.side}
      data-blank={page.isBlank || undefined}
      data-view={placement.view}
      style={{ left: f.x, top: f.y, width: f.width, height: f.height }}
    >
      {header.length > 0 && (
        <div
          className="nv-slot nv-slot-header nv-page-muted"
          style={{ left: c.x - f.x, top: 0, width: geometry.contentWidth, height: geometry.margins.top }}
        >
          {header.map((s) => (
            <div key={s.id} data-slot-id={s.id}>
              {s.render(ctx(geometry.margins.top))}
            </div>
          ))}
        </div>
      )}
      {footer.length > 0 && (
        <div
          className="nv-slot nv-slot-footer nv-page-muted"
          style={{ left: c.x - f.x, bottom: 0, width: geometry.contentWidth, height: geometry.margins.bottom }}
        >
          {footer.map((s) => (
            <div key={s.id} data-slot-id={s.id}>
              {s.render(ctx(geometry.margins.bottom))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
