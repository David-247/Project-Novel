import { useEffect, useLayoutEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { getChapters, chapterIndexAt, getEditor, blockPlainText } from '@/features/editor'
import { useStore, type RewriteRecord } from '@/shared/store'
import { Button, cn, Dialog, formatShortcut, Tooltip } from '@/shared/ui'
import { passageProblem, passageRange } from './anchor'
import { reopenRewrite } from './choice'
import { dismissNotice, focusRevision, openList, openRewrite, setViewHooks } from './commands'
import { REWRITE_CONTROLS as C } from './controls'
import { CHOICE_ORIGINAL } from './model'
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
  const overlay = useRef<HTMLDivElement>(null)

  const behind = useRef<HTMLDivElement>(null)
  const gutter = useRef<'stable' | 'none'>('stable')

  // The pages' scroller stops scrolling behind the view (rewrite.css) and keeps its scrollbar's room
  // only when it shows a scrollbar that takes room: Book mode's one-spread desk usually fits the
  // window and has none (and overlay scrollbars take none), so reserving a gutter there would narrow
  // the pages and refit them on every open and close. Measured when the store opens a re-write,
  // before React renders the view (the scroller is still as it was).
  useEffect(
    () =>
      useStore.subscribe((s, prev) => {
        if (s.rewrite.openId === null || prev.rewrite.openId !== null) return
        const scroller = behind.current?.parentElement
        if (!(scroller instanceof HTMLElement)) return
        const cs = getComputedStyle(scroller)
        const bar = scroller.offsetWidth - scroller.clientWidth - parseFloat(cs.borderLeftWidth || '0') - parseFloat(cs.borderRightWidth || '0')
        gutter.current = bar > 0.5 && scroller.scrollHeight > scroller.clientHeight + 1 ? 'stable' : 'none'
      }),
    [],
  )
  useLayoutEffect(() => {
    if (open && overlay.current) overlay.current.dataset.gutter = gutter.current
  }, [open])

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
        <div ref={overlay} className="nv-rw-overlay">
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
        ref={behind}
        aria-hidden={open || undefined}
        onFocusCapture={(e) => {
          // The store, not this render's `open`: a choice closes the view and focuses the manuscript before React re-renders.
          if (!open || !useStore.getState().rewrite.openId) return
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
    if (notice?.kind !== 'undo' && notice?.kind !== 'discarded') return
    const t = setTimeout(dismissNotice, UNDO_NOTICE_MS)
    return () => clearTimeout(t)
  }, [notice])
  let text: string | null = null
  if (notice?.kind === 'undo') text = 'Undo changed text in a passage that is in re-write.'
  else if (notice?.kind === 'missing') text = `The passage for this re-write was removed. Its versions are kept${notice.id ? '; reopen it to copy text out' : ''}.`
  else if (notice?.kind === 'split') text = `The passage for this re-write is no longer in one piece. Its versions are kept${notice.id ? '; reopen it to copy text out' : ''}.`
  else if (inView) text = null
  else if (notice?.kind === 'notFound')
    text = notice.ambiguous
      ? 'The text this re-write left fits more than one place in the manuscript, so it was not reopened (Novel does not guess). Its versions are kept.'
      : 'The text this re-write left was not found near where it was, so it cannot be reopened. Its versions are kept.'
  else if (notice?.kind === 'discarded') text = `Re-write discarded. Undo (${formatShortcut('Mod-z')}) brings it back.`
  else if (notice?.kind === 'span') text = 'A re-write covers one chapter at most. Select paragraphs within one chapter and try again.'
  else if (notice?.kind === 'locked' && record) text = 'This passage is being re-written, so it cannot be changed here. Edit it in its re-write.'
  else if (record) text = 'This passage is being re-written. It is locked until you choose a version.'
  if (!text) return null
  // Refusals and errors are alerts; the undo notice only informs (nothing was refused).
  const alert = notice !== null && notice.kind !== 'undo' && notice.kind !== 'discarded'
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

/** How a resolved re-write was resolved, for the list: "Kept the original", "Kept Version 2". */
function choiceText(r: RewriteRecord): string {
  if (r.choice === CHOICE_ORIGINAL) return 'Kept the original'
  const v = r.choice ? r.versions.find((x) => x.id === r.choice) : undefined
  return v ? `Kept ${v.name}` : r.kept ? 'Kept a version' : 'Resolved'
}

/** "Chapter 2, The Storm: 'It was a dark…'" for the list. */
function describe(r: RewriteRecord): { where: string; preview: string } {
  const ed = getEditor()
  const first = r.original.content?.[0]
  const text = (n: typeof first): string => (n ? (n.text ?? '') + (n.content ?? []).map((c) => text(c)).join('') : '')
  const preview = text(first).trim().slice(0, 80) || 'Empty paragraph'
  if (!ed || r.status !== 'open') return { where: '', preview }
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

/**
 * Review ▸ Re-writes…: the re-writes in progress (Open shows one), then the resolved ones with the
 * choice made, newest first (Reopen compares the manuscript's text now with the saved versions).
 */
function RewritesList() {
  const isOpen = useStore((s) => s.rewrite.listOpen)
  const rewrites = useStore((s) => s.rewrite.rewrites)
  if (!isOpen) return null
  const open = rewrites.filter((r) => r.status === 'open')
  const resolved = rewrites.filter((r) => r.status !== 'open').sort((a, b) => ((b.resolvedAt ?? '') < (a.resolvedAt ?? '') ? -1 : 1))
  const row = (r: RewriteRecord) => {
    const d = describe(r)
    const isOpenRow = r.status === 'open'
    const c = isOpenRow ? C.listItem : C.listReopen
    return (
      <li key={r.id} className="flex items-center gap-3 rounded-control px-1 py-1" data-rewrite-status={isOpenRow ? 'open' : 'resolved'}>
        <div className="min-w-0 flex-1">
          <div className="truncate text-ui">{d.preview}</div>
          <div className="truncate text-ui-sm text-text-muted">
            {isOpenRow ? (d.where ? `${d.where}. ` : '') : `${choiceText(r)}. `}
            {r.versions.length} {r.versions.length === 1 ? 'version' : 'versions'}
            {isOpenRow && r.originalChanged ? '. The original changed since.' : ''}
          </div>
        </div>
        <Tooltip controlId={c.id}>
          <Button data-control-id={c.id} data-rewrite-id={r.id} onClick={() => (isOpenRow ? openRewrite(r.id) : reopenRewrite(r.id))}>
            {c.label}
          </Button>
        </Tooltip>
      </li>
    )
  }
  return (
    <Dialog
      open
      onOpenChange={(o) => openList(o)}
      title="Re-writes"
      description="Passages you are re-writing stay locked in the manuscript until you choose. Resolved re-writes keep their versions, so you can reopen one and change your mind."
      closeControlId={C.listClose.id}
      wide
    >
      {open.length === 0 ? (
        <p className="text-text-muted">No re-writes in progress. Select paragraphs and choose Review, Re-write Passage.</p>
      ) : (
        <ul className="flex flex-col gap-1" data-testid="rewrite-list" aria-label="In progress">
          {open.map(row)}
        </ul>
      )}
      {resolved.length ? (
        <>
          <h3 className="mt-3 text-ui-sm font-semibold text-text-muted">Resolved</h3>
          <ul className="flex flex-col gap-1" data-testid="rewrite-list-resolved" aria-label="Resolved">
            {resolved.map(row)}
          </ul>
        </>
      ) : null}
    </Dialog>
  )
}
