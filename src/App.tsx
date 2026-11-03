import { AppShell } from '@/features/app-shell'
import { useColorSchemeSync } from '@/shared/store'

/** Composition root: the only place that wires slices together. */
export function App() {
  useColorSchemeSync()
  return (
    <AppShell
      toolbar={<span className="text-sm font-medium">Novel</span>}
      editor={null}
      statusBar={null}
    />
  )
}
