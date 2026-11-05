import { Editor } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import { EditorState } from '@tiptap/pm/state'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from 'react'
import { activeEditorChanged, createEditorExtensions, setActiveEditorSource, SYSTEM_FONT_STACK } from '@/features/editor'
import { sideFileChanged } from '@/features/storage'
import { pageBox, ptToPx } from '@/shared/book'
import type { DocNodeJSON } from '@/shared/document'
import { notifyCommandStateChanged, setCommandGate } from '@/shared/commands'
import { useStore, type RewriteRecord } from '@/shared/store'
import { ariaKeyshortcuts, Button, cn, detectPlatform, IconButton, ToggleButton, Tooltip } from '@/shared/ui'
import { alignBlocks, diffPassages, type AlignedRow } from './align'
import { applyDiff, applyPads, CompareDecorations, computePads, naturalTops, type Stitch } from './compare'
import {
  closeRewrite,
  currentPassageDoc,
  focusSide,
  newVersion,
  renameVersion,
  selectVersion,
  setLiveView,
  storeVersionDoc,
  toggleFlip,
  toggleShowCurrent,
  toggleShowDiff,
} from './commands'
import { discardRewrite, keepOriginal, keepVersion } from './choice'
import { REWRITE_CONTROLS as C } from './controls'
import { rewriteCommandGate } from './gate'
import './rewrite.css'

/** Word highlights follow typing after this pause (the levelling itself follows every keystroke). */
export const DIFF_DEBOUNCE_MS = 150
/** A paragraph added or removed: the pairs are redone after this pause (Enter / Backspace held down). */
export const REALIGN_DEBOUNCE_MS = 60
/** The revision is copied into the store after this pause (and on every save, snapshot, close). */
const FLUSH_MS = 400
/** The gap between the pages (px): the spine with its stitches. */
const SPINE = 44

/** Timing of the last open (e2e perf): from mount to the first aligned layout. */
export const rewriteDebug = { mountedAt: 0, readyAt: 0, layouts: 0, rows: [] as AlignedRow[] }

/**
 * The re-write comparison view: in place of the manuscript's pages while a re-write is open. The
 * original passage on one page (read-only) and the revision on the other (an editor with the
 * manuscript's schema and styles), on the book's paper at the book's trim width; paired paragraphs
 * level with each other, differences highlighted, versions on tabs. docs/design.md, "Re-write".
 */
export function RewriteView() {
  const openId = useStore((s) => s.rewrite.openId)
  const record = useStore((s) => (openId ? s.rewrite.rewrites.find((r) => r.id === openId) : undefined))
  // Resolved or removed while shown (an undo / redo of a choice): back to the manuscript.
  const gone = !!openId && (!record || record.status !== 'open')
  useEffect(() => {
    if (gone) closeRewrite()
  }, [gone])
  if (!record || record.status !== 'open') return null
  return <Comparison key={record.id} record={record} />
}

type PageEditor = Editor

function makeEditor(mount: HTMLElement, doc: DocNodeJSON, editable: boolean, attrs: Record<string, string>): PageEditor {
  return new Editor({
    element: mount,
    extensions: [...createEditorExtensions({ detached: true }), CompareDecorations],
    content: doc as never,
    editable,
    enableCoreExtensions: { delete: false },
    editorProps: { attributes: { class: 'novel-editor-content nv-rw-text', spellcheck: editable ? 'true' : 'false', ...attrs } },
  })
}

function stateFor(ed: PageEditor, doc: DocNodeJSON): EditorState {
  let node: PMNode
  try {
    node = ed.schema.nodeFromJSON(doc)
    node.check()
  } catch (err) {
    console.error('[rewrite] a version does not fit the schema; showing it empty', err)
    node = ed.schema.topNodeType.createAndFill()!
  }
  return EditorState.create({ schema: ed.schema, doc: node, plugins: ed.state.plugins })
}

function Comparison({ record }: { record: RewriteRecord }) {
  const activeVersionId = useStore((s) => s.rewrite.activeVersionId)
  const showDiff = useStore((s) => s.rewrite.showDiff)
  const flipped = useStore((s) => s.rewrite.flipped)
  const narrowSide = useStore((s) => s.rewrite.narrowSide)
  const showCurrent = useStore((s) => s.rewrite.showCurrent)
  const trimSize = useStore((s) => s.book.trimSize)
  const margins = useStore((s) => s.book.margins)
  const actions = useStore((s) => s.rewriteActions)

  const version = record.versions.find((v) => v.id === activeVersionId) ?? record.versions[record.versions.length - 1]
  const versionIndex = record.versions.indexOf(version)

  const box = useMemo(() => pageBox(trimSize, margins), [trimSize, margins])
  const pageStyle = useMemo(
    () => ({
      width: box.page.width,
      minHeight: box.page.height,
      paddingTop: ptToPx(margins.top),
      paddingBottom: ptToPx(margins.bottom),
      // The manuscript's base face (styles without a font of their own inherit it, as on the pages).
      fontFamily: SYSTEM_FONT_STACK,
    }),
    [box, margins],
  )
  const sideMargins = (verso: boolean): CSSProperties => ({
    paddingLeft: ptToPx(verso ? margins.outside : margins.inside),
    paddingRight: ptToPx(verso ? margins.inside : margins.outside),
  })

  const rootRef = useRef<HTMLElement>(null)
  const scrollerRef = useRef<HTMLDivElement>(null)
  const origMount = useRef<HTMLDivElement>(null)
  const revMount = useRef<HTMLDivElement>(null)
  const textRef = useRef<HTMLDivElement>(null)
  const spineRef = useRef<HTMLDivElement>(null)
  const [narrow, setNarrow] = useState(false)
  const [stitches, setStitches] = useState<Stitch[]>([])

  // The two page editors and the per-version states (each version keeps its own undo history while the view is open).
  const eds = useRef<{ orig: PageEditor; rev: PageEditor } | null>(null)
  const states = useRef(new Map<string, EditorState>())
  const dirty = useRef(new Set<string>())
  const shownVersion = useRef(version.id)
  const rows = useRef<AlignedRow[]>([])
  const rowsStale = useRef(false)
  const live = useRef({ showDiff, narrow, recordId: record.id })
  useLayoutEffect(() => {
    live.current = { showDiff, narrow, recordId: record.id }
  })

  // ---- Alignment and differences -------------------------------------------------------------
  const frame = useRef(0)
  const diffTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const layout = useCallback(() => {
    frame.current = 0
    const e = eds.current
    const text = textRef.current
    if (!e || !text || e.orig.isDestroyed || e.rev.isDestroyed) return
    // The pairs are out of date (a paragraph was added or removed): the pads stay on their blocks
    // (decorations follow the edit) until the pairs are redone, instead of levelling the wrong ones.
    if (rowsStale.current) return
    if (live.current.narrow) {
      applyPads(e.orig.view, [])
      applyPads(e.rev.view, [])
      setStitches((s) => (s.length ? [] : s))
      return
    }
    // Tops relative to the spine, so its stitches use them as they are.
    const origin = (spineRef.current ?? text).getBoundingClientRect().top
    const natL = naturalTops(e.orig.view, origin)
    const natR = naturalTops(e.rev.view, origin)
    const { left, right, stitches: next } = computePads(rows.current, natL, natR)
    applyPads(e.orig.view, left)
    applyPads(e.rev.view, right)
    rewriteDebug.layouts++
    if (!rewriteDebug.readyAt) rewriteDebug.readyAt = performance.now()
    setStitches((s) => (s.length === next.length && s.every((x, i) => x.kind === next[i].kind && Math.abs(x.top - next[i].top) < 0.5) ? s : next))
  }, [])

  const scheduleLayout = useCallback(() => {
    if (!frame.current) frame.current = requestAnimationFrame(layout)
  }, [layout])

  /** Re-align the blocks and redo the word diff now. */
  const compare = useCallback(() => {
    clearTimeout(diffTimer.current)
    const e = eds.current
    if (!e || e.orig.isDestroyed || e.rev.isDestroyed) return
    const a = e.orig.state.doc
    const b = e.rev.state.doc
    rows.current = alignBlocks(a, b)
    rowsStale.current = false
    rewriteDebug.rows = rows.current
    const diff = live.current.showDiff ? diffPassages(a, b, rows.current) : null
    applyDiff(e.orig.view, 'left', diff)
    applyDiff(e.rev.view, 'right', diff)
    scheduleLayout()
  }, [scheduleLayout])

  // ---- Copy the revision into the store -------------------------------------------------------
  const flushTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const flush = useCallback(() => {
    clearTimeout(flushTimer.current)
    const e = eds.current
    if (e && !e.rev.isDestroyed) states.current.set(shownVersion.current, e.rev.state)
    for (const vid of dirty.current) {
      const st = states.current.get(vid)
      if (st) storeVersionDoc(live.current.recordId, vid, st.doc.toJSON() as DocNodeJSON)
    }
    dirty.current.clear()
  }, [])

  // ---- Create the editors (once per re-write) --------------------------------------------------
  useLayoutEffect(() => {
    rewriteDebug.mountedAt = performance.now()
    rewriteDebug.readyAt = 0
    const om = origMount.current!
    const rm = revMount.current!
    const orig = makeEditor(om, record.original, false, {
      // Read-only text to read and select, not a field: a document (Tiptap would call it a textbox).
      role: 'document',
      'aria-readonly': 'true',
      'aria-label': 'Original passage',
      'data-testid': 'rewrite-original',
      tabindex: '0',
    })
    const rev = makeEditor(rm, version.doc, true, {
      role: 'textbox',
      'aria-multiline': 'true',
      'aria-label': 'Revised passage',
      'data-testid': 'rewrite-revision',
    })
    eds.current = { orig, rev }
    shownVersion.current = version.id
    const onTr = ({ transaction }: { transaction: { docChanged: boolean; doc: PMNode; before: PMNode } }) => {
      if (!transaction.docChanged) return
      states.current.set(shownVersion.current, rev.state)
      dirty.current.add(shownVersion.current)
      // Unsaved: the project's save status, autosave and the unsaved-changes prompts see it at once.
      sideFileChanged()
      clearTimeout(flushTimer.current)
      flushTimer.current = setTimeout(flush, FLUSH_MS)
      // Re-measure every frame; redo the pairs and the word diff after a pause (shorter when a paragraph
      // was added or removed; until then the levelling waits, see layout).
      const countChanged = transaction.doc.childCount !== transaction.before.childCount
      if (countChanged) rowsStale.current = true
      scheduleLayout()
      const delay = countChanged ? REALIGN_DEBOUNCE_MS : DIFF_DEBOUNCE_MS
      clearTimeout(diffTimer.current)
      diffTimer.current = setTimeout(compare, delay)
    }
    rev.on('transaction', onTr)
    compare()
    // Heights change with fonts, styles, wrapping: re-measure (coalesced per frame).
    const ro = new ResizeObserver(scheduleLayout)
    ro.observe(orig.view.dom)
    ro.observe(rev.view.dom)
    // Text commands (menus, shortcuts, native menu) act on the revision while it has the focus in the
    // view, and are disabled while another part of the view has it; manuscript-wide commands are off.
    let revisionActive = true
    const onFocusIn = (e: FocusEvent) => {
      const t = e.target as Node | null
      const root = rootRef.current
      if (!t || !root) return
      const next = rev.view.dom.contains(t) ? true : root.contains(t) ? false : revisionActive
      if (next === revisionActive) return
      revisionActive = next
      activeEditorChanged()
      notifyCommandStateChanged()
    }
    document.addEventListener('focusin', onFocusIn)
    const offSource = setActiveEditorSource(() => (revisionActive ? rev : null))
    const offGate = setCommandGate(rewriteCommandGate)
    setLiveView({
      flush,
      focus: (side) => {
        const e = eds.current
        if (!e) return
        const leftIsRevision = useStore.getState().rewrite.flipped
        const target = (side === 'left') === leftIsRevision ? 'rev' : 'orig'
        if (live.current.narrow) actions.setNarrowSide(target === 'rev' ? 'revised' : 'original')
        requestAnimationFrame(() => {
          // Closed in the meantime (a choice made): nothing to focus.
          if (e.rev.isDestroyed || e.orig.isDestroyed) return
          if (target === 'rev') e.rev.commands.focus()
          else e.orig.view.dom.focus()
        })
      },
    })
    // The revised page takes the focus, at the start of the passage.
    requestAnimationFrame(() => {
      if (!rev.isDestroyed) rev.commands.focus('start')
    })
    return () => {
      document.removeEventListener('focusin', onFocusIn)
      offGate()
      offSource()
      ro.disconnect()
      setLiveView(null)
      clearTimeout(flushTimer.current)
      clearTimeout(diffTimer.current)
      if (frame.current) cancelAnimationFrame(frame.current)
      frame.current = 0
      eds.current = null
      orig.destroy()
      rev.destroy()
    }
    // Per re-write (the component is keyed by it); versions and the original are swapped below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---- Switch versions -------------------------------------------------------------------------
  useLayoutEffect(() => {
    const e = eds.current
    if (!e || shownVersion.current === version.id) return
    states.current.set(shownVersion.current, e.rev.state)
    shownVersion.current = version.id
    e.rev.view.updateState(states.current.get(version.id) ?? stateFor(e.rev, version.doc))
    compare()
    // version.doc is read only when the version is first shown (later the live state wins).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version.id, compare])

  // ---- The original page: the snapshot, or the passage as it is now ("original changed") ---------
  const problem = useStore((s) => s.rewrite.problems[record.anchor])
  const current = showCurrent && record.originalChanged && !problem
  const { original, anchor } = record
  useLayoutEffect(() => {
    const e = eds.current
    if (!e) return
    const doc = current ? (currentPassageDoc({ ...record, original, anchor }) ?? original) : original
    e.orig.view.updateState(stateFor(e.orig, doc))
    compare()
    // Not on every version flush (`record` changes then): only when what the page shows changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, original, anchor, compare])

  useEffect(() => {
    compare()
  }, [showDiff, compare])

  // ---- Narrow windows: one page at a time -----------------------------------------------------
  useLayoutEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller) return
    const need = 2 * box.page.width + SPINE + 32
    const check = () => setNarrow(scroller.clientWidth < need)
    check()
    const ro = new ResizeObserver(check)
    ro.observe(scroller)
    return () => ro.disconnect()
  }, [box.page.width])
  useEffect(() => {
    scheduleLayout()
  }, [narrow, flipped, scheduleLayout])

  // ---- Keys: Escape closes; the in-view shortcuts (by key code: Option changes letters on macOS) ---
  const onKeyDown = (e: ReactKeyboardEvent) => {
    const mac = detectPlatform() === 'mac'
    const mod = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
    // Escape closes, from the pages too (an editor keymap may mark the key handled); the rename field
    // keeps its own Escape (cancel).
    if (e.key === 'Escape' && !e.altKey && !mod && !e.shiftKey && !(e.target as Element).closest('input')) {
      e.preventDefault()
      closeRewrite()
      return
    }
    if (e.defaultPrevented) return
    // AltGr is Ctrl+Alt on Windows (and some layouts type characters with it): never a shortcut.
    if (e.getModifierState?.('AltGraph')) return
    // A letter: by key code on macOS (Option changes the character), by the character elsewhere, as the
    // registry matches (a Ctrl+Alt press that types another character is that character, not the shortcut).
    const letter = (code: string, key: string) => (mac ? e.code === code : e.key.toLowerCase() === key)
    if (mod && e.altKey && !e.shiftKey) {
      if (letter('KeyK', 'k')) toggleFlip()
      else if (e.key === 'ArrowLeft') focusSide('left')
      else if (e.key === 'ArrowRight') focusSide('right')
      else return
      e.preventDefault()
    } else if (mod && e.shiftKey && !e.altKey && letter('KeyD', 'd')) {
      e.preventDefault()
      toggleShowDiff()
    }
  }

  const passageLabel = useMemo(() => {
    const n = (record.original.content ?? []).length
    return `${n} ${n === 1 ? 'paragraph' : 'paragraphs'}`
  }, [record.original])

  const revisedName = `Revised: ${version.name}`
  const origSide = (
    <div className="nv-rw-col" style={{ order: flipped ? 3 : 1 }} hidden={narrow && narrowSide !== 'original'} data-side="original">
      <div className="nv-rw-label">
        <span>Original</span>
        <span className="nv-rw-label-sub">{current ? 'as it is in the manuscript now' : 'as it was when you started'}</span>
      </div>
      <section
        aria-label="Original"
        className={cn('nv-page nv-rw-page', flipped ? 'nv-page--recto' : 'nv-page--verso')}
        style={{ ...pageStyle, ...sideMargins(!flipped) }}
      >
        <div ref={origMount} />
      </section>
      <ChoiceButton side="original" disabled={!!problem} />
    </div>
  )
  const revSide = (
    <div className="nv-rw-col" style={{ order: flipped ? 1 : 3 }} hidden={narrow && narrowSide !== 'revised'} data-side="revised">
      <div className="nv-rw-label">
        <span>{version.name}</span>
        <span className="nv-rw-label-sub">your revision</span>
      </div>
      <section
        id="nv-rw-revised"
        aria-label={`Revised version ${versionIndex + 1}`}
        aria-roledescription="page"
        className={cn('nv-page nv-rw-page', flipped ? 'nv-page--verso' : 'nv-page--recto')}
        style={{ ...pageStyle, ...sideMargins(flipped) }}
      >
        <div ref={revMount} />
      </section>
      <ChoiceButton side="revised" disabled={!!problem} versionName={version.name} />
    </div>
  )

  return (
    <section ref={rootRef} className="nv-rw" aria-label="Re-write" data-testid="rewrite-view" onKeyDown={onKeyDown}>
      <RewriteBar record={record} activeId={version.id} passageLabel={passageLabel} narrow={narrow} revisedName={revisedName} />
      {problem ? <MissingBanner problem={problem} /> : record.originalChanged ? <ChangedBanner current={!!current} /> : null}
      <div ref={scrollerRef} className="nv-rw-scroller">
        <div
          ref={textRef}
          className="nv-rw-spread"
          data-narrow={narrow || undefined}
          data-flipped={flipped || undefined}
          style={{ '--nv-text-w': `${box.content.width}px` } as CSSProperties}
        >
          {origSide}
          {narrow ? null : (
            <div ref={spineRef} className="nv-rw-spine" style={{ order: 2 }} aria-hidden="true" data-testid="rewrite-spine">
              {stitches.map((s, i) => (
                // Level with the row's first line (stitch centre about half a line below the block top).
                <span key={i} className="nv-rw-stitch" data-kind={s.kind} style={{ top: Math.max(0, s.top + 5) }} />
              ))}
            </div>
          )}
          {revSide}
        </div>
      </div>
    </section>
  )
}

// ---- Header: passage, version tabs, toggles, close ------------------------------------------------

function PenIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" className="size-4">
      <path d="M4 16l.8-3.2 8.4-8.4a1.6 1.6 0 012.4 2.4l-8.4 8.4L4 16z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  )
}

function FlipIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" className="size-5">
      <path d="M3 7h12l-3-3M17 13H5l3 3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function RewriteBar({ record, activeId, passageLabel, narrow, revisedName }: { record: RewriteRecord; activeId: string; passageLabel: string; narrow: boolean; revisedName: string }) {
  const showDiff = useStore((s) => s.rewrite.showDiff)
  const narrowSide = useStore((s) => s.rewrite.narrowSide)
  const setNarrowSide = useStore((s) => s.rewriteActions.setNarrowSide)
  const [renaming, setRenaming] = useState<string | null>(null)
  const tabsRef = useRef<HTMLDivElement>(null)

  const onTabKey = (e: ReactKeyboardEvent, i: number) => {
    const n = record.versions.length
    const k = e.key === 'ArrowRight' ? (i + 1) % n : e.key === 'ArrowLeft' ? (i - 1 + n) % n : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : -1
    if (k < 0 || e.altKey || e.ctrlKey || e.metaKey) return
    e.preventDefault()
    selectVersion(record.versions[k].id)
    requestAnimationFrame(() => tabsRef.current?.querySelectorAll<HTMLElement>('[role="tab"]')[k]?.focus())
  }

  return (
    <div className="flex min-h-toolbar flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border bg-bg px-3 py-1.5 text-text" data-testid="rewrite-bar">
      <div className="flex min-w-0 items-baseline gap-2">
        <h2 className="text-ui font-semibold">Re-write</h2>
        <span className="truncate text-ui-sm text-text-muted">{passageLabel}</span>
      </div>
      <div ref={tabsRef} role="tablist" aria-label="Versions" className="flex min-w-0 flex-wrap items-center gap-1">
        {record.versions.map((v, i) =>
          renaming === v.id ? (
            <RenameField
              key={v.id}
              name={v.name}
              onDone={(name) => {
                if (name !== null) renameVersion(v.id, name)
                setRenaming(null)
                requestAnimationFrame(() => tabsRef.current?.querySelectorAll<HTMLElement>('[role="tab"]')[i]?.focus())
              }}
            />
          ) : (
            <Tooltip key={v.id} controlId={C.versionTab.id}>
              <button
                type="button"
                role="tab"
                data-control-id={C.versionTab.id}
                data-version-id={v.id}
                aria-selected={v.id === activeId}
                aria-controls="nv-rw-revised"
                tabIndex={v.id === activeId ? 0 : -1}
                onClick={() => selectVersion(v.id)}
                onDoubleClick={() => setRenaming(v.id)}
                onKeyDown={(e) => onTabKey(e, i)}
                className={cn(
                  'relative inline-flex min-h-control items-center rounded-control px-3 text-ui-sm focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus-ring',
                  v.id === activeId
                    ? 'bg-surface-raised font-semibold text-text shadow-[inset_0_-2px_0_var(--nv-accent)]'
                    : 'text-text-muted hover:bg-surface-hover hover:text-text',
                )}
              >
                {v.name}
              </button>
            </Tooltip>
          ),
        )}
        {renaming ? null : (
          <Tooltip controlId={C.rename.id}>
            <IconButton label={C.rename.label} data-control-id={C.rename.id} onClick={() => setRenaming(activeId)}>
              <PenIcon />
            </IconButton>
          </Tooltip>
        )}
        <Tooltip controlId={C.newVersion.id}>
          <Button data-control-id={C.newVersion.id} variant="ghost" onClick={() => newVersion()}>
            New version
          </Button>
        </Tooltip>
      </div>
      <span className="flex-1" />
      {narrow ? (
        <div role="group" aria-label="Page shown" className="flex items-center gap-0.5 rounded-control border border-border-control p-0.5">
          <Tooltip controlId={C.showOriginal.id}>
            <ToggleButton data-control-id={C.showOriginal.id} pressed={narrowSide === 'original'} onPressedChange={() => setNarrowSide('original')} className="px-2.5 text-ui-sm">
              Original
            </ToggleButton>
          </Tooltip>
          <Tooltip controlId={C.showRevised.id}>
            <ToggleButton data-control-id={C.showRevised.id} pressed={narrowSide === 'revised'} onPressedChange={() => setNarrowSide('revised')} className="px-2.5 text-ui-sm" aria-label={revisedName}>
              Revised
            </ToggleButton>
          </Tooltip>
        </div>
      ) : null}
      <Tooltip controlId={C.showDiff.id}>
        <ToggleButton
          data-control-id={C.showDiff.id}
          aria-keyshortcuts={ariaKeyshortcuts(C.showDiff.shortcut)}
          pressed={showDiff}
          onPressedChange={toggleShowDiff}
          className="px-2.5 text-ui-sm"
        >
          Differences
        </ToggleButton>
      </Tooltip>
      {narrow ? null : (
        <Tooltip controlId={C.flip.id}>
          <IconButton label={C.flip.label} data-control-id={C.flip.id} aria-keyshortcuts={ariaKeyshortcuts(C.flip.shortcut)} onClick={toggleFlip}>
            <FlipIcon />
          </IconButton>
        </Tooltip>
      )}
      <Tooltip controlId={C.discard.id}>
        <Button data-control-id={C.discard.id} variant="ghost" onClick={() => discardRewrite()}>
          Discard
        </Button>
      </Tooltip>
      <Tooltip controlId={C.closeButton.id}>
        <Button data-control-id={C.closeButton.id} aria-keyshortcuts="Escape" onClick={() => closeRewrite()}>
          Close
        </Button>
      </Tooltip>
    </div>
  )
}

/**
 * The choice, under each page (sticky at the bottom of the view while the page is taller than it):
 * Keep Original under the original, Keep This Version (the primary action) under the revision.
 * Disabled while the passage is missing or split in the manuscript (nothing to replace).
 */
function ChoiceButton({ side, disabled, versionName }: { side: 'original' | 'revised'; disabled: boolean; versionName?: string }) {
  const c = side === 'original' ? C.keepOriginal : C.keepVersion
  return (
    <div className="nv-rw-choice">
      <Tooltip controlId={c.id}>
        <Button
          data-control-id={c.id}
          variant={side === 'revised' ? 'primary' : 'secondary'}
          size="lg"
          disabled={disabled}
          aria-label={side === 'revised' && versionName ? `${c.label}: ${versionName}` : undefined}
          className="min-w-48 px-6 font-semibold shadow-raised"
          onClick={() => (side === 'original' ? keepOriginal() : void keepVersion())}
        >
          {c.label}
        </Button>
      </Tooltip>
    </div>
  )
}

function RenameField({ name, onDone }: { name: string; onDone: (name: string | null) => void }) {
  const [value, setValue] = useState(name)
  const done = useRef(false)
  const finish = (v: string | null) => {
    if (done.current) return
    done.current = true
    onDone(v)
  }
  return (
    <Tooltip controlId={C.renameField.id}>
      <input
        data-control-id={C.renameField.id}
        aria-label={C.renameField.label}
        className="min-h-control w-40 rounded-control border border-border-control bg-surface-raised px-2 text-ui-sm text-text focus-visible:outline-2 focus-visible:outline-focus-ring"
        value={value}
        maxLength={60}
        autoFocus
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => finish(value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            finish(value)
          } else if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            finish(null)
          }
        }}
      />
    </Tooltip>
  )
}

/** The passage is gone from the manuscript (or in pieces): nothing to compare with or replace. */
function MissingBanner({ problem }: { problem: 'missing' | 'split' }) {
  return (
    <div role="status" className="border-b border-border bg-surface-raised px-3 py-1.5 text-ui-sm text-text" data-testid="rewrite-missing">
      {problem === 'missing'
        ? 'The passage for this re-write was removed from the manuscript. Your versions are kept: copy text out of them. The original page shows the passage as it was.'
        : 'The passage for this re-write is no longer in one piece in the manuscript. Your versions are kept: copy text out of them. The original page shows the passage as it was.'}
    </div>
  )
}

function ChangedBanner({ current }: { current: boolean }) {
  return (
    <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border bg-surface-raised px-3 py-1.5 text-ui-sm text-text" data-testid="rewrite-changed">
      <span>The passage changed in the manuscript after you started this re-write.</span>
      <Tooltip controlId={C.compareCurrent.id}>
        <ToggleButton data-control-id={C.compareCurrent.id} pressed={current} onPressedChange={toggleShowCurrent} className="px-2.5 text-ui-sm">
          {C.compareCurrent.label}
        </ToggleButton>
      </Tooltip>
    </div>
  )
}
