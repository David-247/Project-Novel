import { useEffect, useLayoutEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { getChapters, chapterIndexAt, getEditor, blockPlainText } from '@/features/editor'
import { useStore, type RewriteRecord } from '@/shared/store'
import { Button, cn, Dialog, Tooltip } from '@/shared/ui'
import { passageProblem, passageRange } from './anchor'
import { dismissNotice, focusRevision, openList, openRewrite, setViewHooks } from './commands'
import { REWRITE_CONTROLS as C } from './controls'
import { RewriteView } from './RewriteView'

export interface RewriteHostProps {
  /** The manuscript's canvas (the paginated view). Kept mounted and laid out while a re-write is open. */
  children: ReactNode
}

/**
 * Composition-root wrapper around the manuscript's canvas: while a re-write is open the comparison
 * view lies over it (the canvas stays mounted, laid out and scrolled where it was, so the
 * manuscript's editor, its undo history and the page model are untouched). Closing gives the
 * manuscript back where it was. Also shows the manuscript's re-write notice and the Re-writes list.
 */
export function RewriteHost({ children }: RewriteHostProps) {
  const open = useStore((s) => s.rewrite.openId !== null)
  const restore = useRef(false)

  useEffect(() => setViewHooks({ afterClose: () => void (restore.current = true) }), [])

  // Back to the manuscript (still scrolled where it was): the focus in the text, its selection kept.
  useLayoutEffect(() => {
    if (open || !restore.current) return
    restore.current = false
    const ed = getEditor()
    if (ed && !ed.isDestroyed) ed.view.focus()
  }, [open])

  return (
    <>
      {open ? (
        <div className="nv-rw-overlay">
          <RewriteView />
          {/* Notices that can come up while the view is open (a refused undo). */}
          <RewriteNotice inView />
        </div>
      ) : (
        <RewriteNotice />
      )}
      {/* Behind the view: hidden from screen readers, and the keyboard focus never stays there (Tab from
          the view's last control lands in the manuscript's view otherwise). Not `inert`: that restyles
          the whole manuscript on every open (over 200 ms at 100k words). */}
      <div
        aria-hidden={open || undefined}
        onFocusCapture={(e) => {
          if (!open) return
          ;(e.target as HTMLElement).blur?.()
          focusRevision()
        }}
      >
        {children}
      </div>
      <RewritesList />
    </>
  )
}

/** The undo notice goes away by itself after this long. */
const UNDO_NOTICE_MS = 6000

/**
 * The manuscript's re-write notice, floating over the top of the pages: shown while the caret is in a
 * passage that is being re-written (with the way back to its re-write), stronger after an edit there
 * was refused, when a selection spans more than one chapter, and when an edit removed a passage.
 * `inView`: over the comparison view, only what can happen while it is open (an undo that changed or
 * removed the passage).
 */
function RewriteNotice({ inView = false }: { inView?: boolean }) {
  const notice = useStore((s) => s.rewrite.notice)
  const caretIn = useStore((s) => s.rewrite.caretIn)
  const rewrites = useStore((s) => s.rewrite.rewrites)
  const anchorId = notice && 'id' in notice && notice.id ? notice.id : caretIn
  const record = anchorId ? rewrites.find((r) => r.anchor === anchorId && r.status === 'open') : undefined
  // A refused edit's notice stays until the caret moves to or from a passage (or Dismiss): an edit
  // refused at a passage's edge (Backspace joining into it) leaves the caret outside, and still shows.
  const lastCaret = useRef(caretIn)
  useEffect(() => {
    if (lastCaret.current === caretIn) return
    lastCaret.current = caretIn
    if (notice?.kind === 'locked' || notice?.kind === 'undo') dismissNotice()
  }, [caretIn, notice])
  // The undo notice only informs: it goes away by itself.
  useEffect(() => {
    if (notice?.kind !== 'undo') return
    const t = setTimeout(dismissNotice, UNDO_NOTICE_MS)
    return () => clearTimeout(t)
  }, [notice])
  let text: string | null = null
  if (notice?.kind === 'undo') text = 'Undo changed text in a passage that is in re-write.'
  else if (notice?.kind === 'missing') text = `The passage for this re-write was removed. Its versions are kept${notice.id ? '; reopen it to copy text out' : ''}.`
  else if (notice?.kind === 'split') text = `The passage for this re-write is no longer in one piece. Its versions are kept${notice.id ? '; reopen it to copy text out' : ''}.`
  else if (inView) text = null
  else if (notice?.kind === 'span') text = 'A re-write covers one chapter at most. Select paragraphs within one chapter and try again.'
  else if (notice?.kind === 'locked' && record) text = 'This passage is being re-written, so it cannot be changed here. Edit it in its re-write.'
  else if (record) text = 'This passage is being re-written. It is locked until you choose a version.'
  if (!text) return null
  // Refusals and errors are alerts; the undo notice only informs (nothing was refused).
  const alert = notice !== null && notice.kind !== 'undo'
  const dismissable = notice !== null
  const offerOpen = record && !inView
  return (
    <div
      className={cn(
        'pointer-events-none z-30 flex h-0 items-start justify-center px-2 sm:px-4',
        inView ? 'absolute inset-x-0 top-12' : 'sticky top-0',
      )}
    >
      <div
        role={alert ? 'alert' : 'status'}
        data-testid="rewrite-notice"
        className="pointer-events-auto mt-2 flex max-w-[min(40rem,100%)] flex-wrap items-center gap-x-3 gap-y-1 rounded-panel border border-border bg-surface-raised px-3 py-1.5 text-ui-sm text-text shadow-raised"
      >
        <span className="min-w-0 flex-1">{text}</span>
        {offerOpen ? (
          <Tooltip controlId={C.noticeOpen.id}>
            <Button data-control-id={C.noticeOpen.id} variant={alert ? 'primary' : 'secondary'} onClick={() => openRewrite(record.id)}>
              {C.noticeOpen.label}
            </Button>
          </Tooltip>
        ) : null}
        {dismissable ? (
          <Tooltip controlId={C.noticeDismiss.id}>
            <Button data-control-id={C.noticeDismiss.id} variant="ghost" onClick={dismissNotice}>
              {C.noticeDismiss.label}
            </Button>
          </Tooltip>
        ) : null}
      </div>
    </div>
  )
}

/** "Chapter 2, The Storm: 'It was a dark…'" for the list. */
function describe(r: RewriteRecord): { where: string; preview: string } {
  const ed = getEditor()
  const first = r.original.content?.[0]
  const text = (n: typeof first): string => (n ? (n.text ?? '') + (n.content ?? []).map((c) => text(c)).join('') : '')
  const preview = text(first).trim().slice(0, 80) || 'Empty paragraph'
  if (!ed) return { where: '', preview }
  const range = passageRange(ed.state.doc, r.anchor)
  if (!range)
    return {
      where: passageProblem(ed.state.doc, r.anchor) === 'split' ? 'Passage no longer in one piece in the manuscript' : 'Passage no longer in the manuscript',
      preview,
    }
  const chapters = getChapters(ed.state.doc)
  const i = chapterIndexAt(chapters, range.from)
  const chapter = i >= 0 ? chapters[i] : null
  const title = chapter ? blockPlainText(ed.state.doc.nodeAt(chapter.from) ?? ed.state.doc.child(0)).trim() : ''
  return { where: chapter ? `Chapter ${i + 1}${title ? `: ${title}` : ''}` : 'Before the first chapter', preview }
}

/** Review ▸ Re-writes…: every re-write in progress, in manuscript order; Open shows it. */
function RewritesList() {
  const isOpen = useStore((s) => s.rewrite.listOpen)
  const rewrites = useStore((s) => s.rewrite.rewrites)
  if (!isOpen) return null
  const open = rewrites.filter((r) => r.status === 'open')
  return (
    <Dialog open onOpenChange={(o) => openList(o)} title="Re-writes" description="Passages you are re-writing. Each stays locked in the manuscript until you choose a version." closeControlId={C.listClose.id} wide>
      {open.length === 0 ? (
        <p className="text-text-muted">No re-writes in progress. Select paragraphs and choose Review, Re-write Passage.</p>
      ) : (
        <ul className="flex flex-col gap-1" data-testid="rewrite-list">
          {open.map((r) => {
            const d = describe(r)
            return (
              <li key={r.id} className="flex items-center gap-3 rounded-control px-1 py-1">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-ui">{d.preview}</div>
                  <div className="truncate text-ui-sm text-text-muted">
                    {d.where ? `${d.where}. ` : ''}
                    {r.versions.length} {r.versions.length === 1 ? 'version' : 'versions'}
                    {r.originalChanged ? '. The original changed since.' : ''}
                  </div>
                </div>
                <Tooltip controlId={C.listItem.id}>
                  <Button data-control-id={C.listItem.id} data-rewrite-id={r.id} onClick={() => openRewrite(r.id)}>
                    {C.listItem.label}
                  </Button>
                </Tooltip>
              </li>
            )
          })}
        </ul>
      )}
    </Dialog>
  )
}
