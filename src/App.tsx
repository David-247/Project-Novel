import { AppShell } from '@/features/app-shell'
import { useThemeFollow } from '@/shared/theme'

/** Composition root: the only place that wires slices together. */
export function App() {
  useThemeFollow()
  return (
    <AppShell
      toolbar={<span className="px-1 text-ui font-semibold">Novel</span>}
      editor={null}
      statusBar={null}
    />
  )
}
