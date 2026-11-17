import type { PaperSurface } from '@/shared/book'
import { notifyCommandStateChanged, registerCommands } from '@/shared/commands'
import { useStore } from '@/shared/store'
import { SURFACE_CONTROLS } from './surface'

const DESCRIPTIONS: Record<PaperSurface, string> = {
  book: 'Cream paper with a shaded spine, like an open printed book.',
  white: 'Plain white paper on a grey desk, like a word processor.',
  dark: 'Dark paper with light text, easy on the eyes at night.',
  auto: 'White paper in light mode, dark paper in dark mode. Follows your computer.',
}

/** View > Paper ▸ Book, White, Dark, Auto (same ids as the paper picker). Returns unregister. */
export function registerSurfaceCommands(): () => void {
  const options = [SURFACE_CONTROLS.book, SURFACE_CONTROLS.white, SURFACE_CONTROLS.dark, SURFACE_CONTROLS.auto]
  const off = registerCommands(
    options.map((o, i) => ({
      id: o.id,
      label: o.label,
      description: DESCRIPTIONS[o.value],
      menu: { id: 'view' as const, group: 'paper', order: 30 + i / 100, submenu: 'Paper' },
      isChecked: () => useStore.getState().book.surface === o.value,
      run: () => useStore.getState().bookActions.setSurface(o.value),
    })),
  )
  const unsubscribe = useStore.subscribe((s, p) => {
    if (s.book.surface !== p.book.surface) notifyCommandStateChanged()
  })
  return () => {
    unsubscribe()
    off()
  }
}
