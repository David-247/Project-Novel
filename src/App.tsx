import { useEffect } from 'react'
import { AppShell } from '@/features/app-shell'
import {
  FindButton,
  FindReplacePanel,
  getDocJSON,
  getDocVersion,
  HistoryButtons,
  isDirty,
  markClean,
  NovelEditor,
  onDocChange,
  setDocJSON,
  Toolbar,
  ToolbarItem,
} from '@/features/editor'
import { SaveStatusIndicator, useStorageIntegration } from '@/features/storage'
import { getTooltipCopy } from '@/features/tooltips'
import { registerDocumentProvider, type DocJSON, type DocumentProvider } from '@/shared/document'
import { ToolbarGroup, TooltipProvider } from '@/shared/ui'
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
    // One provider for every tooltip: hover delay + the registry as the copy source.
    <TooltipProvider lookup={getTooltipCopy}>
      <AppShell
        toolbar={
          <>
            <span className="px-1 text-ui font-semibold">Novel</span>
            <Toolbar
              leadingGroups={
                <ToolbarGroup label="History">
                  <HistoryButtons
                    wrap={(button, { disabled }) => <ToolbarItem disabled={disabled}>{button}</ToolbarItem>}
                  />
                </ToolbarGroup>
              }
              extraGroups={
                <ToolbarGroup label="Find">
                  <ToolbarItem>
                    <FindButton />
                  </ToolbarItem>
                </ToolbarGroup>
              }
            />
          </>
        }
        editor={
          <>
            {/* Zero-height sticky anchor: the find panel floats at the top of the scrolling editor
                region (never over the toolbar, whatever its wrapped height) and takes no layout
                space while closed. Full width minus gutters on narrow screens. */}
            <div className="pointer-events-none sticky top-0 z-10 flex h-0 items-start justify-end px-2 sm:px-4">
              <FindReplacePanel className="pointer-events-auto mt-2" />
            </div>
            <NovelEditor />
          </>
        }
        statusBar={<SaveStatusIndicator />}
      />
    </TooltipProvider>
  )
}
