import type { ReactNode } from 'react'

export interface AppShellProps {
  toolbar: ReactNode
  editor: ReactNode
  statusBar?: ReactNode
}

export function AppShell({ toolbar, editor, statusBar }: AppShellProps) {
  return (
    <div className="flex h-full flex-col">
      <header
        role="banner"
        aria-label="Toolbar"
        className="flex min-h-10 items-center gap-2 border-b border-current/20 px-3"
      >
        {toolbar}
      </header>
      <main role="main" aria-label="Editor" className="min-h-0 flex-1 overflow-auto">
        {editor}
      </main>
      {statusBar ? (
        <footer
          aria-label="Status bar"
          className="flex min-h-8 items-center border-t border-current/20 px-3 text-sm"
        >
          {statusBar}
        </footer>
      ) : null}
    </div>
  )
}
