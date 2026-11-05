import { useEffect } from 'react'
import { AppShell, useReloadGuard } from '@/features/app-shell'
import {
  FindButton,
  FindReplacePanel,
  getDocJSON,
  getDocVersion,
  HistoryButtons,
  InsertMenu,
  isDirty,
  markClean,
  markDirty,
  NovelEditor,
  onDocChange,
  setDocJSON,
  Toolbar,
  ToolbarItem,
} from '@/features/editor'
import { TrimSizePicker } from '@/features/book-settings'
import { HeaderFooter, HeaderFooterButton } from '@/features/header-footer'
import {
  NoProjectActions,
  RecoveryDialog,
  RecoveryStatus,
  SaveStatusIndicator,
  useStorageIntegration,
} from '@/features/storage'
import { PageIndicator, PaginatedView, ZoomControls } from '@/features/pagination'
import { FootnoteOptionsButton, useFootnotePagination } from '@/features/footnotes'
import { SettingsButton, SettingsDialog, useSettingsIntegration } from '@/features/settings'
import { getTooltipCopy } from '@/features/tooltips'
import { registerDocumentProvider, type DocJSON, type DocumentProvider } from '@/shared/document'
import { ToolbarGroup, ToolbarSeparator, TooltipProvider } from '@/shared/ui'
import { SurfacePicker, useSurfaceFollow, useThemeFollow } from '@/shared/theme'

/** The editor slice, seen by storage through the shared DocumentProvider contract. */
export const editorDocumentProvider: DocumentProvider = {
  getDocJSON: () => getDocJSON() as DocJSON,
  setDocJSON: (doc) => setDocJSON(doc),
  isDirty,
  getDocVersion,
  markClean,
  markDirty,
  onDocChange,
}

/** Composition root: the only place that wires slices together. */
export function App() {
  useThemeFollow()
  useSurfaceFollow()
  // F5 / Mod-R / Alt+Left would reload or navigate the webview and drop unsaved work. Kept off under
  // the Vite dev server (`pnpm dev`, `pnpm tauri dev`), where reloading is part of the workflow.
  useReloadGuard(!import.meta.env.DEV)
  useEffect(() => registerDocumentProvider(editorDocumentProvider), [])
  useStorageIntegration()
  // App preferences: load/save preferences.json, Mod-, opens Settings, the Motion preference.
  useSettingsIntegration()
  // Footnotes at the bottom of their page (bottom reservations + the footnote area page slot).
  useFootnotePagination()
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
                <>
                  <ToolbarGroup label="Find">
                    <ToolbarItem>
                      <FindButton />
                    </ToolbarItem>
                  </ToolbarGroup>
                  <ToolbarSeparator />
                  <ToolbarGroup label="Insert">
                    <ToolbarItem>
                      <InsertMenu />
                    </ToolbarItem>
                    <ToolbarItem>
                      <FootnoteOptionsButton />
                    </ToolbarItem>
                  </ToolbarGroup>
                  <ToolbarSeparator />
                  <ToolbarGroup label="Paper">
                    <SurfacePicker wrap={(button) => <ToolbarItem>{button}</ToolbarItem>} />
                  </ToolbarGroup>
                  <ToolbarSeparator />
                  <ToolbarGroup label="Book layout">
                    <ToolbarItem>
                      <TrimSizePicker />
                    </ToolbarItem>
                    <ToolbarItem>
                      <HeaderFooterButton />
                    </ToolbarItem>
                  </ToolbarGroup>
                  <ToolbarSeparator />
                  <ToolbarGroup label="App">
                    <ToolbarItem>
                      <SettingsButton />
                    </ToolbarItem>
                  </ToolbarGroup>
                </>
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
            <PaginatedView>
              <NovelEditor paged />
            </PaginatedView>
          </>
        }
        statusBar={
          <>
            <SaveStatusIndicator />
            <RecoveryStatus />
            <span className="flex-1" />
            <NoProjectActions />
            <PageIndicator />
            <ZoomControls />
          </>
        }
      />
      {/* Running heads / page numbers in the page margins, and their dialogs (portal). */}
      <HeaderFooter />
      {/* Settings dialog and the one-time author question (portal). */}
      <SettingsDialog />
      {/* Crash-recovery prompts (portal). */}
      <RecoveryDialog />
    </TooltipProvider>
  )
}
