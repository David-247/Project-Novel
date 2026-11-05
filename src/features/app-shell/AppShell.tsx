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
 * wraps, the editor region scrolls, and the status bar truncates.
 */
export function AppShell({ menuBar, toolbar, editor, statusBar }: AppShellProps) {
  return (
    <div className="flex h-full flex-col bg-bg text-text">
      {menuBar}
      <header
        role="banner"
        aria-label="App controls"
        className="flex min-h-toolbar flex-wrap items-center gap-x-1 gap-y-1 border-b border-border bg-bg px-2 py-1.5 sm:px-3"
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
          className="flex min-h-statusbar min-w-0 flex-wrap items-center gap-x-4 gap-y-1 overflow-hidden border-t border-border bg-bg px-3 py-0.5 text-ui-xs text-text-muted"
        >
          {statusBar}
        </footer>
      ) : null}
    </div>
  )
}
