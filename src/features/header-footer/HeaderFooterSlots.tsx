import { memo, useEffect, useMemo, useSyncExternalStore } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { registerPageSlot } from '@/features/pagination'
import type { PageSlotContext } from '@/features/pagination'
import { useStore } from '@/shared/store'
import { openHeaderFooterDialog } from './dialog-state'
import { getTitlesVersion, resolvePage, subscribeTitles, trackChapterTitles } from './model'
import { RunningHeadView, useRunningHeadCSS, type HFRegion } from './RunningHeadView'

/**
 * One region of one page. Subscribes to the store through a selector that returns the resolved
 * strings (shallow-compared), so a keystroke that leaves this page's head and number unchanged
 * re-renders nothing here, and a chapter-title edit re-renders only the pages whose text changed.
 */
const PageHeadSlot = memo(function PageHeadSlot({ region, pageIndex }: { region: HFRegion; pageIndex: number }) {
  // A chapter title edit does not republish the layout: this version change re-runs the selector.
  const titles = useSyncExternalStore(subscribeTitles, getTitlesVersion, getTitlesVersion)
  const selector = useMemo(
    () => (s: Parameters<typeof resolvePage>[0]) => {
      void titles
      return resolvePage(s, pageIndex) ?? EMPTY
    },
    [pageIndex, titles],
  )
  const resolved = useStore(useShallow(selector))
  const css = useRunningHeadCSS()
  return <RunningHeadView region={region} resolved={resolved} css={css} />
})

const EMPTY = { headerText: '', number: '', numberPosition: null, side: 'recto' } as const

const render = (region: HFRegion) => (ctx: PageSlotContext) => <PageHeadSlot region={region} pageIndex={ctx.page.index} />

/**
 * Mounts nothing visible: registers the header and footer page slots with the pagination slice
 * (double-clicking either region opens the "Headers & page numbers" dialog) and watches chapter
 * titles. Render once, anywhere under the app.
 */
export function HeaderFooterSlots() {
  useEffect(() => {
    const open = () => openHeaderFooterDialog('settings')
    const offs = [
      registerPageSlot({ id: 'header-footer.header', region: 'header', order: 0, render: render('header'), onDoubleClick: open }),
      registerPageSlot({ id: 'header-footer.footer', region: 'footer', order: 0, render: render('footer'), onDoubleClick: open }),
      trackChapterTitles(),
    ]
    return () => offs.forEach((off) => off())
  }, [])
  return null
}
