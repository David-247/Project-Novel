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
import { CommentsLayout, CommentsPanelButton, NewCommentButton, registerCommentsSideFile } from '@/features/comments'
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
  // Footnotes at the bottom of their page (bottom reservations + the footnote area page slot).
  useFootnotePagination()
  // comments.json is saved, autosaved and recovered with the manuscript (storage side file).
  useEffect(() => registerCommentsSideFile(), [])
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
                  <ToolbarGroup label="Comments">
                    <ToolbarItem>
                      <NewCommentButton />
                    </ToolbarItem>
                    <ToolbarItem>
                      <CommentsPanelButton />
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
            {/* The comments margin panel sits beside the pages (a drawer in a narrow window). */}
            <CommentsLayout>
              <PaginatedView>
                <NovelEditor paged />
              </PaginatedView>
            </CommentsLayout>
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
      {/* Crash-recovery prompts (portal). */}
      <RecoveryDialog />
    </TooltipProvider>
  )
}
