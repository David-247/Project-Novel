import { notifyCommandStateChanged, registerCommands, type Command } from '@/shared/commands'
import { useStore } from '@/shared/store'
import { PAGINATION_CONTROLS as C } from './controls'
import { goToEdgeSpread, turnSpread } from './navigation'
import { MAX_SCALE, MIN_SCALE, rowCountFor, stepZoom, ZOOM_STEPS } from './placement'

const layout = () => useStore.getState().layout
const setZoom = (z: Parameters<ReturnType<typeof useStore.getState>['layoutActions']['setZoom']>[0]) =>
  useStore.getState().layoutActions.setZoom(z)
const pct = () => Math.round(layout().scale * 100)
const navigation = () => useStore.getState().preferences.pageNavigation
const setNavigation = (v: 'book' | 'scroll') => useStore.getState().preferencesActions.set('pageNavigation', v)
const hasPages = () => layout().pageCount > 0
const edgeKey = (l: ReturnType<typeof layout>) => {
  const last = rowCountFor(l.pageCount, l.effectiveView) - 1
  return `${l.visibleSpread.index <= 0}|${l.visibleSpread.index >= last}`
}
const atFirstSpread = () => layout().visibleSpread.index <= 0
const atLastSpread = () => layout().visibleSpread.index >= rowCountFor(layout().pageCount, layout().effectiveView) - 1

/** View menu: single page / spread, zoom (the status bar's controls, by the same ids where they exist). */
export const PAGINATION_COMMANDS: readonly Command[] = [
  {
    id: 'view.singlePage',
    label: 'Single Page',
    description: 'Show one page at a time.',
    menu: { id: 'view', group: 'layout', order: 10 },
    isChecked: () => useStore.getState().book.view === 'single',
    run: () => useStore.getState().bookActions.setView('single'),
  },
  {
    id: C.spreadView.id,
    label: 'Two-Page Spread',
    description: 'Show facing pages side by side like an open book.',
    menu: { id: 'view', group: 'layout', order: 11 },
    isChecked: () => useStore.getState().book.view === 'spread',
    run: () => useStore.getState().bookActions.setView('spread'),
  },
  // Navigation mode: an app preference (Settings > Page navigation), not per book.
  {
    id: 'view.bookNavigation',
    label: 'Book',
    description: 'Show one spread at a time and turn the pages like a book.',
    menu: { id: 'view', group: 'navigation', order: 1 },
    guard: 'none',
    isChecked: () => navigation() === 'book',
    run: () => setNavigation('book'),
  },
  {
    id: 'view.scrollNavigation',
    label: 'Continuous Scroll',
    description: 'Show every page in one long column and scroll through them.',
    menu: { id: 'view', group: 'navigation', order: 2 },
    guard: 'none',
    isChecked: () => navigation() === 'scroll',
    run: () => setNavigation('scroll'),
  },
  // Spread navigation. No registry shortcut: PageUp / PageDown and Ctrl+Home / Ctrl+End (Cmd+Up /
  // Cmd+Down on macOS) are the pagination view's own keys (they move the caret in the manuscript and
  // turn the view from anywhere else), so a second binding here would run twice.
  {
    id: C.previousSpread.id,
    label: 'Previous Spread',
    description: 'Show the pages before these (Page Up in the manuscript).',
    menu: { id: 'view', group: 'spreads', order: 5 },
    guard: 'none',
    isEnabled: () => hasPages() && !atFirstSpread(),
    run: () => void turnSpread(-1),
  },
  {
    id: C.nextSpread.id,
    label: 'Next Spread',
    description: 'Show the pages after these (Page Down in the manuscript).',
    menu: { id: 'view', group: 'spreads', order: 6 },
    guard: 'none',
    isEnabled: () => hasPages() && !atLastSpread(),
    run: () => void turnSpread(1),
  },
  {
    id: 'view.firstSpread',
    label: 'First Spread',
    description: 'Show the first pages of the book.',
    menu: { id: 'view', group: 'spreads', order: 7 },
    guard: 'none',
    isEnabled: () => hasPages() && !atFirstSpread(),
    run: () => void goToEdgeSpread(-1),
  },
  {
    id: 'view.lastSpread',
    label: 'Last Spread',
    description: 'Show the last pages of the book.',
    menu: { id: 'view', group: 'spreads', order: 8 },
    guard: 'none',
    isEnabled: () => hasPages() && !atLastSpread(),
    run: () => void goToEdgeSpread(1),
  },
  {
    id: C.zoomIn.id,
    label: 'Zoom In',
    description: 'Make the pages larger on screen. The book itself does not change.',
    shortcut: C.zoomIn.shortcut,
    menu: { id: 'view', group: 'zoom', order: 20 },
    isEnabled: () => layout().scale < MAX_SCALE - 0.001 && pct() < ZOOM_STEPS[ZOOM_STEPS.length - 1],
    run: () => setZoom({ mode: 'percent', percent: stepZoom(layout().scale, 1) }),
  },
  {
    id: C.zoomOut.id,
    label: 'Zoom Out',
    description: 'Make the pages smaller on screen. The book itself does not change.',
    shortcut: C.zoomOut.shortcut,
    menu: { id: 'view', group: 'zoom', order: 21 },
    isEnabled: () => layout().scale > MIN_SCALE + 0.001 && pct() > ZOOM_STEPS[0],
    run: () => setZoom({ mode: 'percent', percent: stepZoom(layout().scale, -1) }),
  },
  {
    id: 'view.fitSpread',
    label: 'Fit Spread',
    description: 'Size the pages so the whole spread fits in the window.',
    menu: { id: 'view', group: 'zoom', order: 22 },
    isChecked: () => layout().zoom.mode === 'fit-spread',
    run: () => setZoom({ mode: 'fit-spread' }),
  },
  {
    id: 'view.fitWidth',
    label: 'Fit Width',
    description: 'Size the pages to the width of the window.',
    menu: { id: 'view', group: 'zoom', order: 23 },
    isChecked: () => layout().zoom.mode === 'fit-width',
    run: () => setZoom({ mode: 'fit-width' }),
  },
  {
    id: 'view.actualSize',
    label: 'Actual Size',
    description: 'Show the pages at 100%.',
    shortcut: 'Mod-0',
    menu: { id: 'view', group: 'zoom', order: 24 },
    isChecked: () => layout().zoom.mode === 'percent' && layout().zoom.percent === 100,
    run: () => setZoom({ mode: 'percent', percent: 100 }),
  },
]

/** Register the View menu's page-view and zoom commands. Returns unregister. */
export function registerPaginationCommands(): () => void {
  const off = registerCommands(PAGINATION_COMMANDS)
  const unsubscribe = useStore.subscribe((s, p) => {
    if (
      s.book.view !== p.book.view ||
      s.layout.zoom !== p.layout.zoom ||
      s.layout.scale !== p.layout.scale ||
      s.layout.pageCount !== p.layout.pageCount ||
      s.layout.effectiveView !== p.layout.effectiveView ||
      // Only the spread commands' enabled state depends on the spread: notify when it reaches or
      // leaves an end, not on every turn (each notification re-renders the menus).
      edgeKey(s.layout) !== edgeKey(p.layout) ||
      s.preferences.pageNavigation !== p.preferences.pageNavigation
    )
      notifyCommandStateChanged()
  })
  return () => {
    unsubscribe()
    off()
  }
}
