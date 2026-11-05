import { getVersion } from '@tauri-apps/api/app'
import { isTauri } from '@tauri-apps/api/core'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { goToPage } from '@/features/pagination'
import { MENU_LABELS, useCommands, type Command, type MenuId } from '@/shared/commands'
import { useStore } from '@/shared/store'
import { Button, detectPlatform, Dialog, formatShortcut, TextInput, Tooltip } from '@/shared/ui'
import projectFormatDoc from '../../../docs/project-format.md?raw'
import { menuDialogOpenCount, openMenuDialog, useMenuDialog } from './dialog-state'
import { restoreFocus } from './focus'
import { renderMarkdown } from './markdown'

/** Control ids of the menu slice's dialogs (copy: the tooltips registry). */
export const MENU_DIALOG_CONTROLS = {
  shortcutsSearch: { id: 'shortcuts.search', label: 'Search shortcuts' },
  goToPageNumber: { id: 'goToPage.number', label: 'Page number' },
  goToPageGo: { id: 'goToPage.go', label: 'Go' },
  goToPageCancel: { id: 'goToPage.cancel', label: 'Cancel' },
  aboutClose: { id: 'about.close', label: 'OK' },
  formatClose: { id: 'projectFormat.close', label: 'Done' },
} as const

const close = () => openMenuDialog(null)
/** Focus back to the manuscript (with its selection) or the control that had it. */
const giveFocusBack = (e: Event) => {
  e.preventDefault()
  restoreFocus()
}

const MENU_ORDER: MenuId[] = ['file', 'edit', 'view', 'insert', 'format', 'review', 'help', 'app']

/** Help > Keyboard Shortcuts: every registry command with a shortcut, by menu, searchable. */
function ShortcutsDialog({ open }: { open: boolean }) {
  const commands = useCommands()
  const [query, setQuery] = useState('')
  const platform = detectPlatform()
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    return commands
      .filter((c): c is Command & { shortcut: string } => !!c.shortcut)
      .map((c) => ({ c, keys: formatShortcut(c.shortcut, platform) }))
      .filter(({ c, keys }) => !q || `${c.label} ${c.description} ${keys}`.toLowerCase().includes(q))
  }, [commands, query, platform])
  const groups = MENU_ORDER.map((m) => ({ m, rows: rows.filter((r) => (r.c.menu?.id ?? 'app') === m) })).filter((g) => g.rows.length)
  const C = MENU_DIALOG_CONTROLS.shortcutsSearch
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && close()}
      title="Keyboard Shortcuts"
      description="Every shortcut in Novel. The menus show the same keys."
      wide
      onCloseAutoFocus={giveFocusBack}
    >
      <div className="grid gap-3">
        <Tooltip controlId={C.id}>
          <TextInput
            type="search"
            aria-label={C.label}
            placeholder="Search, e.g. bold or Ctrl+B"
            data-control-id={C.id}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </Tooltip>
        <div data-testid="shortcuts-list" className="grid gap-3">
          {groups.length === 0 ? <p className="text-text-muted">No shortcut matches “{query}”.</p> : null}
          {groups.map(({ m, rows }) => (
            <section key={m} aria-label={MENU_LABELS[m].label}>
              <h3 className="pb-1 text-ui-xs font-semibold uppercase tracking-wide text-text-muted">
                {m === 'app' ? 'Novel' : MENU_LABELS[m].label}
              </h3>
              <table className="w-full border-collapse text-ui-sm">
                <tbody>
                  {rows.map(({ c, keys }) => (
                    <tr key={c.id} data-command-id={c.id} className="border-t border-border align-top">
                      <th scope="row" className="py-1.5 pr-3 text-left font-medium">
                        {c.label}
                        <div className="font-normal text-text-muted">{c.description}</div>
                      </th>
                      <td className="whitespace-nowrap py-1.5 text-right">
                        <kbd data-testid="shortcut-keys" className="rounded-control border border-border px-1.5 py-0.5 font-sans">
                          {keys}
                        </kbd>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ))}
        </div>
      </div>
    </Dialog>
  )
}

/** Edit > Go to Page…: a page number, then the caret goes to the start of that page. */
function GoToPageDialog({ open }: { open: boolean }) {
  // Fresh state (the current page) each time it opens.
  return <GoToPageDialogBody key={menuDialogOpenCount()} open={open} />
}

function GoToPageDialogBody({ open }: { open: boolean }) {
  const count = useStore((s) => s.layout.pageCount)
  const [text, setText] = useState(() => String(useStore.getState().layout.currentPage + 1))
  const target = useRef<number | null>(null)
  const fieldId = useId()
  const n = Number(text)
  const valid = Number.isInteger(n) && n >= 1 && n <= count
  const C = MENU_DIALOG_CONTROLS
  const go = () => {
    if (!valid) return
    target.current = n - 1
    close()
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && close()}
      title="Go to Page"
      description={count ? `The book has ${count} ${count === 1 ? 'page' : 'pages'}.` : undefined}
      onCloseAutoFocus={(e) => {
        e.preventDefault()
        const page = target.current
        target.current = null
        if (page === null || !goToPage(page)) restoreFocus()
      }}
      footer={
        <>
          <Tooltip controlId={C.goToPageCancel.id}>
            <Button data-control-id={C.goToPageCancel.id} onClick={close}>
              {C.goToPageCancel.label}
            </Button>
          </Tooltip>
          <Tooltip controlId={C.goToPageGo.id}>
            <Button variant="primary" data-control-id={C.goToPageGo.id} disabled={!valid} onClick={go}>
              {C.goToPageGo.label}
            </Button>
          </Tooltip>
        </>
      }
    >
      <form
        className="grid gap-1"
        onSubmit={(e) => {
          e.preventDefault()
          go()
        }}
      >
        <label htmlFor={fieldId} className="text-ui-sm font-medium">
          {C.goToPageNumber.label}
        </label>
        <Tooltip controlId={C.goToPageNumber.id}>
          <TextInput
            id={fieldId}
            data-control-id={C.goToPageNumber.id}
            inputMode="numeric"
            autoFocus
            value={text}
            aria-invalid={text !== '' && !valid ? true : undefined}
            onChange={(e) => setText(e.target.value.replace(/[^0-9]/g, ''))}
            onFocus={(e) => e.currentTarget.select()}
          />
        </Tooltip>
      </form>
    </Dialog>
  )
}

/** Help > About Novel: name, version (from the app config) and licence. */
function AboutDialog({ open }: { open: boolean }) {
  const [version, setVersion] = useState<string | null>(() => (isTauri() ? null : 'development build'))
  useEffect(() => {
    if (!open || version) return
    getVersion()
      .then(setVersion)
      .catch(() => setVersion('unknown'))
  }, [open, version])
  const C = MENU_DIALOG_CONTROLS.aboutClose
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && close()}
      title="About Novel"
      description="A book-writing app that works offline."
      onCloseAutoFocus={giveFocusBack}
      footer={
        <Tooltip controlId={C.id}>
          <Button variant="primary" data-control-id={C.id} onClick={close}>
            {C.label}
          </Button>
        </Tooltip>
      }
    >
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-ui">
        <dt className="text-text-muted">Version</dt>
        <dd data-testid="about-version">{version ?? '…'}</dd>
        <dt className="text-text-muted">Licence</dt>
        <dd>MIT, open source</dd>
      </dl>
    </Dialog>
  )
}

/** Help > Project Folder Format: docs/project-format.md, bundled with the app (no network). */
function ProjectFormatDialog({ open }: { open: boolean }) {
  const body = useMemo<ReactNode>(() => (open ? renderMarkdown(projectFormatDoc) : null), [open])
  const C = MENU_DIALOG_CONTROLS.formatClose
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && close()}
      title="Project Folder Format"
      description="How Novel keeps a project on disk, file by file."
      wide
      onCloseAutoFocus={giveFocusBack}
      footer={
        <Tooltip controlId={C.id}>
          <Button variant="primary" data-control-id={C.id} onClick={close}>
            {C.label}
          </Button>
        </Tooltip>
      }
    >
      <article data-testid="project-format-doc" className="grid gap-2 text-ui leading-relaxed">
        {body}
      </article>
    </Dialog>
  )
}

/** The menu slice's dialogs (portals). Render once. */
export function MenuDialogs() {
  const open = useMenuDialog()
  return (
    <>
      <ShortcutsDialog open={open === 'shortcuts'} />
      <GoToPageDialog open={open === 'goToPage'} />
      <AboutDialog open={open === 'about'} />
      <ProjectFormatDialog open={open === 'projectFormat'} />
    </>
  )
}
