import type { ReactNode } from 'react'

export interface AppShellProps {
  /** The in-app menu bar, above the toolbar (absent where the menu is native: macOS). */
  menuBar?: ReactNode
  toolbar: ReactNode
  editor: ReactNode
  statusBar?: ReactNode
}

/**
 * Three planes: quiet chrome (toolbar, status bar on `bg`) around the brightest, calmest
 * plane, the desk the page lies on (`desk`, from the paper surface). Nothing here assumes a desktop width: the toolbar
 * (the ribbon) keeps one fixed-height row and scales its groups, the editor region scrolls, and the status bar
 * keeps one row, hiding its low-priority items before anything wraps: the footer is the `statusbar` container,
 * and status-bar items shrink with container queries on it (`@max-[640px]/statusbar:hidden`), widest first:
 * the page indicator shortens then goes, the project buttons become icons, zoom keeps only its menu.
 */
export function AppShell({ menuBar, toolbar, editor, statusBar }: AppShellProps) {
  return (
    <div className="flex h-full flex-col bg-bg text-text">
      {menuBar}
      <header
        role="banner"
        aria-label="App controls"
        className="flex shrink-0 items-stretch overflow-hidden border-b border-border bg-bg px-2 pb-1 sm:px-3"
      >
        {toolbar}
      </header>
      <main
        role="main"
        aria-label="Editor"
        className="min-h-0 flex-1 overflow-auto bg-desk text-text"
      >
        {editor}
      </main>
      {statusBar ? (
        <footer
          aria-label="Status bar"
          className="@container/statusbar flex h-statusbar min-w-0 shrink-0 flex-nowrap items-center gap-x-4 overflow-hidden whitespace-nowrap border-t border-border bg-bg px-3 text-ui-xs text-text-muted"
        >
          {statusBar}
        </footer>
      ) : null}
    </div>
  )
}
