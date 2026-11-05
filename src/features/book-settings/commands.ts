import { TRIM_SIZES } from '@/shared/book'
import { notifyCommandStateChanged, registerCommands } from '@/shared/commands'
import { useStore } from '@/shared/store'
import { chooseTrimSize, trimSizeItemControlId } from './TrimSizePicker'

/** File > Page Setup ▸ one item per trim size (checked: the book's size). Returns unregister. */
export function registerBookSettingsCommands(): () => void {
  const off = registerCommands(
    TRIM_SIZES.map((t, i) => ({
      id: trimSizeItemControlId(t.id),
      label: `${t.label} (${t.dimensions})`,
      description: `Lay the book out on ${t.dimensions} pages.`,
      menu: { id: 'file' as const, group: 'book', order: 20 + i / 1000, submenu: 'Page Setup' },
      isChecked: () => useStore.getState().book.trimSize === t.id,
      run: () => chooseTrimSize(t.id),
    })),
  )
  const unsubscribe = useStore.subscribe((s, p) => {
    if (s.book.trimSize !== p.book.trimSize) notifyCommandStateChanged()
  })
  return () => {
    unsubscribe()
    off()
  }
}
