import { AppShell } from '@/features/app-shell'
import { FontFamilyPicker, NovelEditor } from '@/features/editor'
import { useColorSchemeSync } from '@/shared/store'

/** Composition root: the only place that wires slices together. */
export function App() {
  useColorSchemeSync()
  return (
    <AppShell
      toolbar={
        <>
          <span className="text-sm font-medium">Novel</span>
          <FontFamilyPicker />
        </>
      }
      editor={<NovelEditor />}
      statusBar={null}
    />
  )
}
