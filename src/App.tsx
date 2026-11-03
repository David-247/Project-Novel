import { AppShell } from '@/features/app-shell'
import { SaveStatusIndicator, useStorageIntegration } from '@/features/storage'
import { useColorSchemeSync } from '@/shared/store'

/** Composition root: the only place that wires slices together. */
export function App() {
  useColorSchemeSync()
  useStorageIntegration()
  return (
    <AppShell
      toolbar={<span className="text-sm font-medium">Novel</span>}
      editor={null}
      statusBar={<SaveStatusIndicator />}
    />
  )
}
