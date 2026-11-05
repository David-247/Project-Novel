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
  registerEditorCommands,
  setDocJSON,
  Toolbar,
  ToolbarItem,
} from '@/features/editor'
import { registerBookSettingsCommands, TrimSizePicker } from '@/features/book-settings'
import { HeaderFooter, HeaderFooterButton, registerHeaderFooterCommands } from '@/features/header-footer'
import {
  NoProjectActions,
  RecoveryDialog,
  RecoveryStatus,
  registerStorageCommands,
  SaveStatusIndicator,
  useStorageIntegration,
} from '@/features/storage'
import { invalidatePaginationAt, PageIndicator, PaginatedView, registerPaginationCommands, ZoomControls } from '@/features/pagination'
import { FootnoteOptionsButton, registerFootnoteCommands, useFootnotePagination } from '@/features/footnotes'
import { AppMenuBar, MenuDialogs, useAppMenus } from '@/features/menu'
import {
  ensureAuthorName,
  getAuthor,
  registerSettingsCommands,
  SettingsButton,
  SettingsDialog,
  useSettingsIntegration,
} from '@/features/settings'
import {
  CommentsLayout,
  CommentsPanelButton,
  NewCommentButton,
  registerCommentsCommands,
  registerCommentsSideFile,
  setBeforeNewComment,
  setCommentAuthorSource,
} from '@/features/comments'
import {
  MarkupViewMenu,
  registerTrackChangesCommands,
  setMarkupViewRepaginate,
  setOnTrackingSwitchedOn,
  setTrackChangesAuthorSource,
  TrackChangesButton,
  TrackChangesNotice,
} from '@/features/track-changes'
import { registerRewriteCommands, registerRewritesSideFile, RewriteHost } from '@/features/rewrite'
import { getTooltipCopy } from '@/features/tooltips'
import { registerDocumentProvider, type DocJSON, type DocumentProvider } from '@/shared/document'
import { ToolbarGroup, ToolbarSeparator, TooltipProvider } from '@/shared/ui'
import { registerSurfaceCommands, SurfacePicker, useSurfaceFollow, useThemeFollow } from '@/shared/theme'

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
/** Shown on comments and tracked changes when the author has no name (the question was dismissed). */
export const UNKNOWN_AUTHOR = 'Unknown author'

/** The author of comments and tracked changes: the Settings name and colour (`Unknown author` without a name). */
export function commentAuthor(): { name: string; color: string | null } {
  const a = getAuthor()
  return { name: a.name || UNKNOWN_AUTHOR, color: a.color }
}

/**
 * After the author question closed: its dialog gives the focus back (Radix, a task after unmount), so
 * the comment composer, which takes the focus when it opens, must open after that.
 */
const afterDialogFocus = () => new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)))

export function App() {
  useThemeFollow()
  useSurfaceFollow()
  // F5 / Mod-R / Alt+Left would reload or navigate the webview and drop unsaved work. Kept off under
  // the Vite dev server (`pnpm dev`, `pnpm tauri dev`), where reloading is part of the workflow.
  useReloadGuard(!import.meta.env.DEV)
  useEffect(() => registerDocumentProvider(editorDocumentProvider), [])
  useStorageIntegration()
  // App preferences: load/save preferences.json and the Motion preference (Settings… is a command).
  useSettingsIntegration()
  // Footnotes at the bottom of their page (bottom reservations + the footnote area page slot).
  useFootnotePagination()
  // Every slice's menu commands (shared registry), then the menus and shortcuts that render them.
  useEffect(() => {
    const offs = [
      registerStorageCommands(),
      registerEditorCommands(),
      registerPaginationCommands(),
      registerSurfaceCommands(),
      registerBookSettingsCommands(),
      registerHeaderFooterCommands(),
      registerFootnoteCommands(),
      registerSettingsCommands(),
      registerCommentsCommands(),
      registerTrackChangesCommands(),
      registerRewriteCommands(),
    ]
    return () => offs.forEach((off) => off())
  }, [])
  useAppMenus()
  // comments.json is saved, autosaved and recovered with the manuscript (storage side file).
  useEffect(() => registerCommentsSideFile(), [])
  // rewrites.json likewise (re-write versions are saved, autosaved and recovered with the manuscript).
  useEffect(() => registerRewritesSideFile(), [])
  // Comments and tracked changes are by the Settings author. With no name known, New Comment first
  // asks once; switching Track Changes on asks before the first change is recorded (the recorder
  // cannot wait: changes made while the question is open carry "Unknown author").
  useEffect(() => {
    setCommentAuthorSource(commentAuthor)
    setTrackChangesAuthorSource(commentAuthor)
    setBeforeNewComment(() => (getAuthor().name ? null : ensureAuthorName().then(afterDialogFocus)))
    setOnTrackingSwitchedOn(() => {
      if (!getAuthor().name) void ensureAuthorName()
    })
    return () => {
      setCommentAuthorSource(null)
      setTrackChangesAuthorSource(null)
      setBeforeNewComment(null)
      setOnTrackingSwitchedOn(null)
    }
  }, [])
  // Track changes: a markup view switch re-measures the blocks holding changes (hidden text).
  useEffect(() => setMarkupViewRepaginate(invalidatePaginationAt), [])
  return (
    // One provider for every tooltip: hover delay + the registry as the copy source.
    <TooltipProvider lookup={getTooltipCopy}>
      <AppShell
        menuBar={<AppMenuBar />}
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
                  <ToolbarGroup label="Review">
                    <ToolbarItem>
                      <TrackChangesButton />
                    </ToolbarItem>
                    <ToolbarItem>
                      <MarkupViewMenu />
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
            {/* While a re-write is open its comparison view takes the place of the pages (kept mounted). */}
            <RewriteHost>
              {/* The comments margin panel sits beside the pages (a drawer in a narrow window). */}
              <CommentsLayout>
                <PaginatedView>
                  <NovelEditor paged />
                </PaginatedView>
              </CommentsLayout>
            </RewriteHost>
          </>
        }
        statusBar={
          <>
            <SaveStatusIndicator />
            <RecoveryStatus />
            <TrackChangesNotice />
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
      {/* Help and Go to Page dialogs (portal). */}
      <MenuDialogs />
    </TooltipProvider>
  )
}
