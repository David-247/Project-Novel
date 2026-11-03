import { useEffect } from 'react'
import { AppShell } from '@/features/app-shell'
import {
  FontFamilyPicker,
  getDocJSON,
  getDocVersion,
  isDirty,
  markClean,
  NovelEditor,
  onDocChange,
  setDocJSON,
} from '@/features/editor'
import { SaveStatusIndicator, useStorageIntegration } from '@/features/storage'
import { registerDocumentProvider, type DocJSON, type DocumentProvider } from '@/shared/document'
import { useThemeFollow } from '@/shared/theme'

/** The editor slice, seen by storage through the shared DocumentProvider contract. */
export const editorDocumentProvider: DocumentProvider = {
  getDocJSON: () => getDocJSON() as DocJSON,
  setDocJSON: (doc) => setDocJSON(doc),
  isDirty,
  getDocVersion,
  markClean,
  onDocChange,
}

/** Composition root: the only place that wires slices together. */
export function App() {
  useThemeFollow()
  useEffect(() => registerDocumentProvider(editorDocumentProvider), [])
  useStorageIntegration()
  return (
    <AppShell
      toolbar={
        <>
          <span className="px-1 text-ui font-semibold">Novel</span>
          <FontFamilyPicker />
        </>
      }
      editor={<NovelEditor />}
      statusBar={<SaveStatusIndicator />}
    />
  )
}
