import { notifyCommandStateChanged, registerCommands, type Command } from '@/shared/commands'
import { useStore } from '@/shared/store'
import { PAGINATION_CONTROLS as C } from './controls'
import { MAX_SCALE, MIN_SCALE, stepZoom, ZOOM_STEPS } from './placement'

const layout = () => useStore.getState().layout
const setZoom = (z: Parameters<ReturnType<typeof useStore.getState>['layoutActions']['setZoom']>[0]) =>
  useStore.getState().layoutActions.setZoom(z)
const pct = () => Math.round(layout().scale * 100)

/** View menu: single page / spread, zoom (the status bar's controls, by the same ids where they exist). */
export const PAGINATION_COMMANDS: readonly Command[] = [
  {
    id: 'view.singlePage',
    label: 'Single Page',
    description: 'Show one page at a time.',
    menu: { id: 'view', group: 'layout', order: 10 },
    ribbon: { group: 'view.views', order: 10 },
    isChecked: () => useStore.getState().book.view === 'single',
    run: () => useStore.getState().bookActions.setView('single'),
  },
  {
    id: C.spreadView.id,
    label: 'Two-Page Spread',
    description: 'Show facing pages side by side like an open book.',
    menu: { id: 'view', group: 'layout', order: 11 },
    ribbon: { group: 'view.views', order: 20 },
    isChecked: () => useStore.getState().book.view === 'spread',
    run: () => useStore.getState().bookActions.setView('spread'),
  },
  {
    id: C.zoomIn.id,
    label: 'Zoom In',
    description: 'Make the pages larger on screen. The book itself does not change.',
    shortcut: C.zoomIn.shortcut,
    menu: { id: 'view', group: 'zoom', order: 20 },
    ribbon: { group: 'view.zoom', order: 20 },
    isEnabled: () => layout().scale < MAX_SCALE - 0.001 && pct() < ZOOM_STEPS[ZOOM_STEPS.length - 1],
    run: () => setZoom({ mode: 'percent', percent: stepZoom(layout().scale, 1) }),
  },
  {
    id: C.zoomOut.id,
    label: 'Zoom Out',
    description: 'Make the pages smaller on screen. The book itself does not change.',
    shortcut: C.zoomOut.shortcut,
    menu: { id: 'view', group: 'zoom', order: 21 },
    ribbon: { group: 'view.zoom', order: 10 },
    isEnabled: () => layout().scale > MIN_SCALE + 0.001 && pct() > ZOOM_STEPS[0],
    run: () => setZoom({ mode: 'percent', percent: stepZoom(layout().scale, -1) }),
  },
  {
    id: 'view.fitSpread',
    label: 'Fit Spread',
    description: 'Size the pages so the whole spread fits in the window.',
    menu: { id: 'view', group: 'zoom', order: 22 },
    ribbon: { group: 'view.zoom', order: 30 },
    isChecked: () => layout().zoom.mode === 'fit-spread',
    run: () => setZoom({ mode: 'fit-spread' }),
  },
  {
    id: 'view.fitWidth',
    label: 'Fit Width',
    description: 'Size the pages to the width of the window.',
    menu: { id: 'view', group: 'zoom', order: 23 },
    ribbon: { group: 'view.zoom', order: 40 },
    isChecked: () => layout().zoom.mode === 'fit-width',
    run: () => setZoom({ mode: 'fit-width' }),
  },
  {
    id: 'view.actualSize',
    label: 'Actual Size',
    description: 'Show the pages at 100%.',
    shortcut: 'Mod-0',
    menu: { id: 'view', group: 'zoom', order: 24 },
    ribbon: { group: 'view.zoom', order: 50 },
    isChecked: () => layout().zoom.mode === 'percent' && layout().zoom.percent === 100,
    run: () => setZoom({ mode: 'percent', percent: 100 }),
  },
]

/** Register the View menu's page-view and zoom commands. Returns unregister. */
export function registerPaginationCommands(): () => void {
  const off = registerCommands(PAGINATION_COMMANDS)
  const unsubscribe = useStore.subscribe((s, p) => {
    if (s.book.view !== p.book.view || s.layout.zoom !== p.layout.zoom || s.layout.scale !== p.layout.scale || s.layout.pageCount !== p.layout.pageCount)
      notifyCommandStateChanged()
  })
  return () => {
    unsubscribe()
    off()
  }
}
