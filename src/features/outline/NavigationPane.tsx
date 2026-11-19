import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'
import { useMountedEditor } from '@/features/editor'
import { clampNavPaneWidth, NAV_PANE_MAX_WIDTH, NAV_PANE_MIN_WIDTH, useStore } from '@/shared/store'
import { cn, focusRing, IconButton, Tooltip } from '@/shared/ui'
import { closeNavigationPane, dismissOverlay, focusManuscript, onFocusRequest, PANE_ATTR, takeFocusRequest } from './commands'
import { OUTLINE_CONTROLS as C } from './controls'
import { resolveEntry } from './identity'
import { jumpTo } from './jump'
import { buildOutline, entryAt, pageRange, pageRangeSpoken, pageRangeText, type OutlineEntry } from './model'
import { usePresentation } from './presentation'
import { useCurrentPosition, useOutline } from './use-outline'

/** Arrow-key resize step (px); with Shift, a larger one. */
const RESIZE_STEP = 16
const RESIZE_STEP_LARGE = 64
/** Type-ahead: letters typed within this long form one search. */
const TYPEAHEAD_MS = 600

let numberFormat: Intl.NumberFormat | undefined
/** As the status bar formats counts (the locale's grouping). */
const formatCount = (n: number): string => (numberFormat ??= new Intl.NumberFormat()).format(n)
const wordsText = (n: number) => `${formatCount(n)} ${n === 1 ? 'word' : 'words'}`

interface Row {
  entry: OutlineEntry
  /** The entry's stable id: what folding and jumping follow (its key is its place in the tree). */
  id: string
  words: number
  pages: { first: number; last: number } | null
  hasChildren: boolean
  expanded: boolean
  /** 1-based position among its siblings, and their count (flat tree: aria-posinset / aria-setsize). */
  pos: number
  size: number
}

const ChevronIcon = ({ open }: { open: boolean }) => (
  <svg aria-hidden="true" viewBox="0 0 16 16" className={cn('size-3.5 transition-transform duration-100 motion-reduce:transition-none', open && 'rotate-90')} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="m6 4 4 4-4 4" />
  </svg>
)

const CloseIcon = () => (
  <svg aria-hidden="true" viewBox="0 0 20 20" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
    <path d="m5.5 5.5 9 9M14.5 5.5l-9 9" />
  </svg>
)

interface TreeRowProps {
  id: string
  entryKey: string
  /** Stable across edits (what the callbacks take); `entryKey` is its place in the tree. */
  stableId: string
  label: string
  number: number | null
  level: 1 | 2
  words: number
  pagesText: string
  pagesSpoken: string
  hasChildren: boolean
  expanded: boolean
  current: boolean
  focusable: boolean
  disabled: boolean
  pos: number
  size: number
  onActivate: (key: string) => void
  onToggle: (key: string) => void
  onFocusRow: (key: string) => void
}

/** One heading. Memoized on primitives: typing in one chapter re-renders that row only. */
const TreeRow = memo(function TreeRow(p: TreeRowProps) {
  const kind = p.level === 2 ? 'subheading' : p.number !== null ? 'chapter' : 'part'
  const name = p.number !== null ? `Chapter ${p.number}: ${p.label}` : p.label
  const facts = [wordsText(p.words), p.pagesSpoken].filter(Boolean).join(', ')
  const copy = {
    title: name,
    description: `Go to this ${kind === 'part' ? 'part of the manuscript' : kind}. ${[wordsText(p.words), p.pagesText].filter(Boolean).join(', ')}.${
      p.hasChildren ? ' Left and Right, or the arrow, fold its subheadings.' : ''
    }`,
  }
  return (
    <Tooltip copy={copy} side="right">
      <div
        id={p.id}
        role="treeitem"
        data-control-id={C.item.id}
        data-outline-key={p.entryKey}
        data-current={p.current ? 'true' : undefined}
        aria-label={`${name}, ${facts}`}
        aria-level={p.level}
        aria-posinset={p.pos}
        aria-setsize={p.size}
        aria-expanded={p.hasChildren ? p.expanded : undefined}
        aria-selected={p.current}
        aria-disabled={p.disabled || undefined}
        tabIndex={p.focusable ? 0 : -1}
        onFocus={() => p.onFocusRow(p.entryKey)}
        onClick={() => p.onActivate(p.stableId)}
        className={cn(
          'group flex min-h-control cursor-pointer select-none items-start gap-1 rounded-control py-1 pr-2 text-left',
          p.level === 2 ? 'pl-7' : 'pl-1',
          p.current ? 'bg-accent-soft text-accent' : 'text-text hover:bg-surface-hover',
          focusRing,
          'focus-visible:outline-offset-[-2px]',
        )}
      >
        {/* The fold control: pointer and touch only (keyboard: Left / Right on the row). */}
        {p.level === 1 ? (
          p.hasChildren ? (
            // Its own tooltip on hover (the row's says where it goes). Not a tab stop: the keyboard folds
            // with Left / Right on the row, whose tooltip says so on focus.
            <Tooltip controlId={C.fold.id} side="right">
              <span
                aria-hidden="true"
                data-control-id={C.fold.id}
                data-outline-toggle=""
                className="-my-1 inline-flex size-8 shrink-0 items-center justify-center rounded-control hover:bg-surface-hover"
                onClick={(e) => {
                  e.stopPropagation()
                  p.onToggle(p.stableId)
                }}
              >
                <ChevronIcon open={p.expanded} />
              </span>
            </Tooltip>
          ) : (
            <span aria-hidden="true" data-outline-toggle="" className="-my-1 inline-flex size-8 shrink-0 items-center justify-center invisible" />
          )
        ) : null}
        <span className="flex min-w-0 flex-1 flex-col pt-0.5">
          <span className="flex min-w-0 items-baseline gap-1.5">
            {p.number !== null ? <span className="shrink-0 tabular-nums font-semibold">{p.number}</span> : null}
            <span className={cn('truncate', p.level === 1 ? 'font-medium' : '')}>{p.label}</span>
          </span>
          <span className={cn('text-ui-xs tabular-nums', p.current ? 'text-accent' : 'text-text-muted')} data-outline-counts="">
            {wordsText(p.words)}
            {p.pagesText ? ` · ${p.pagesText}` : ''}
          </span>
        </span>
      </div>
    </Tooltip>
  )
})

/** The row for type-ahead matching: the label, and for a chapter its number too. */
const matches = (row: Row, query: string) => {
  const q = query.toLowerCase()
  return row.entry.label.toLowerCase().startsWith(q) || (row.entry.number !== null && String(row.entry.number).startsWith(q))
}

function HeadingsTree({ overlay }: { overlay: boolean }) {
  const editor = useMountedEditor()
  const data = useOutline(editor, true)
  const pages = useStore((s) => s.layout.pages)
  const rewriteOpen = useStore((s) => s.rewrite.openId !== null)
  const currentPos = useCurrentPosition(editor, true)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const [focusKey, setFocusKey] = useState<string | null>(null)
  const treeRef = useRef<HTMLDivElement>(null)
  const typeahead = useRef<{ text: string; at: number }>({ text: '', at: 0 })

  const rows = useMemo<Row[]>(() => {
    if (!data) return []
    const out: Row[] = []
    const top = data.outline.entries
    top.forEach((e, i) => {
      const id = data.ids.get(e.key) ?? e.key
      const expanded = !collapsed.has(id)
      out.push({ entry: e, id, words: data.words.get(e.key) ?? 0, pages: pageRange(pages, e.from, e.to), hasChildren: e.children.length > 0, expanded, pos: i + 1, size: top.length })
      if (expanded) {
        e.children.forEach((c, j) =>
          out.push({ entry: c, id: data.ids.get(c.key) ?? c.key, words: data.words.get(c.key) ?? 0, pages: pageRange(pages, c.from, c.to), hasChildren: false, expanded: false, pos: j + 1, size: e.children.length }),
        )
      }
    })
    return out
  }, [data, pages, collapsed])

  // The highlighted heading: the deepest entry at the current position, or its chapter when folded.
  const currentKey = useMemo(() => {
    if (!data || currentPos === null) return null
    const e = entryAt(data.outline, currentPos)
    if (!e) return null
    if (e.level === 2) {
      const parent = data.outline.entries.find((p) => p.children.includes(e))
      if (parent && collapsed.has(data.ids.get(parent.key) ?? parent.key)) return parent.key
    }
    return e.key
  }, [data, currentPos, collapsed])

  const keys = rows.map((r) => r.entry.key)
  const tabKey = focusKey && keys.includes(focusKey) ? focusKey : currentKey && keys.includes(currentKey) ? currentKey : (keys[0] ?? null)
  const domId = (key: string) => `nv-outline-${key.replace(/[^a-z0-9]/gi, '-')}`

  const focusRow = useCallback((key: string | null) => {
    if (!key) return
    setFocusKey(key)
    const el = treeRef.current?.querySelector<HTMLElement>(`[data-outline-key="${CSS.escape(key)}"]`)
    el?.focus()
  }, [])

  // Keep the highlighted heading in view inside the pane (without moving the focus).
  useEffect(() => {
    if (!currentKey) return
    const el = treeRef.current?.querySelector<HTMLElement>(`[data-outline-key="${CSS.escape(currentKey)}"]`)
    el?.scrollIntoView?.({ block: 'nearest' })
  }, [currentKey])

  const hasData = data !== null
  // The commands' focus request (View ▸ Navigation Pane, its shortcut): to the current heading.
  useEffect(() => {
    // Until the tree is built a request waits (the pane opens first, its rows an idle callback later).
    if (!hasData) return
    const take = () => {
      const stillWanted = takeFocusRequest()
      if (!stillWanted) return
      // After the pane rendered: the row in the tab order (the current heading), else the tree; not
      // when the user clicked or typed elsewhere in the meantime.
      requestAnimationFrame(() => {
        if (!stillWanted()) return
        const tree = treeRef.current
        const row = tree?.querySelector<HTMLElement>('[role="treeitem"][tabindex="0"]')
        if (row) row.focus()
        else tree?.focus()
      })
    }
    take()
    return onFocusRequest(take)
  }, [hasData])

  // What activate reads, kept current outside render so the callback (a row prop) stays stable and the
  // memoized rows do not re-render when the tree is rebuilt.
  const live = useRef({ rewriteOpen, overlay, editor, data })
  useLayoutEffect(() => {
    live.current = { rewriteOpen, overlay, editor, data }
  })

  const activate = useCallback((id: string) => {
    const { rewriteOpen, overlay, editor, data } = live.current
    if (rewriteOpen || !editor || editor.isDestroyed || !data) return
    // The entry in the document as it is now (the tree shown may be an idle callback behind the last
    // keystroke, with a chapter added or removed since): the shown entry's start carried through the
    // edits since, in the outline of the current document (cached per document, so this is cheap).
    const s = useStore.getState()
    const entry = resolveEntry(data, id, buildOutline(editor.state.doc, undefined, s.trackChanges.markupView))
    if (!entry) return
    setFocusKey(entry.key)
    jumpTo(entry.from, { firstPage: pageRange(s.layout.pages, entry.from, entry.to)?.first ?? null })
    if (overlay) dismissOverlay()
  }, [])

  const toggle = useCallback((id: string) => {
    setCollapsed((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  }, [])

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return
    const at = tabKey ? keys.indexOf(tabKey) : -1
    const row = at >= 0 ? rows[at] : null
    const go = (i: number) => {
      e.preventDefault()
      if (i >= 0 && i < rows.length) focusRow(keys[i])
    }
    switch (e.key) {
      case 'ArrowDown':
        return go(Math.min(rows.length - 1, at + 1))
      case 'ArrowUp':
        return go(Math.max(0, at - 1))
      case 'Home':
        return go(0)
      case 'End':
        return go(rows.length - 1)
      case 'ArrowRight':
        e.preventDefault()
        if (!row) return
        if (row.hasChildren && !row.expanded) toggle(row.id)
        else if (row.hasChildren) focusRow(keys[at + 1])
        return
      case 'ArrowLeft': {
        e.preventDefault()
        if (!row) return
        if (row.hasChildren && row.expanded) toggle(row.id)
        else if (row.entry.level === 2) {
          for (let i = at - 1; i >= 0; i--) if (rows[i].entry.level === 1) return focusRow(keys[i])
        }
        return
      }
      case 'Enter':
        e.preventDefault()
        if (row) activate(row.id)
        return
      case 'Escape':
        e.preventDefault()
        if (overlay) dismissOverlay()
        else focusManuscript()
        return
      case ' ':
        // Space activates, unless it continues a type-ahead ("the s…").
        if (!typeahead.current.text || performance.now() - typeahead.current.at > TYPEAHEAD_MS) {
          e.preventDefault()
          if (row) activate(row.id)
          return
        }
        break
    }
    if (e.key.length !== 1 || !rows.length) return
    e.preventDefault()
    const now = performance.now()
    const t = typeahead.current
    t.text = now - t.at > TYPEAHEAD_MS ? e.key : t.text + e.key
    t.at = now
    // A repeated single letter cycles through the rows starting with it; otherwise search from here.
    const repeated = t.text.length > 1 && [...t.text].every((c) => c === t.text[0])
    const query = repeated ? t.text[0] : t.text
    const start = query.length === 1 ? at + 1 : Math.max(0, at)
    for (let k = 0; k < rows.length; k++) {
      const i = (start + k) % rows.length
      if (matches(rows[i], query)) return focusRow(keys[i])
    }
  }

  if (!data) {
    // No manuscript: say so. A manuscript whose tree is still being built (the first idle callback after
    // the pane opened) is not "no manuscript".
    if (!editor) return <p className="px-3 py-2 text-ui-sm text-text-muted">No manuscript is open.</p>
    return (
      <p className="px-3 py-2 text-ui-sm text-text-muted" role="status" aria-busy="true">
        Loading headings…
      </p>
    )
  }
  const tree = (
    <div ref={treeRef} role="tree" aria-label="Headings" tabIndex={tabKey ? -1 : 0} onKeyDown={onKeyDown} className="flex flex-col gap-px px-1 py-1">
      {rows.map((r) => (
        <TreeRow
          key={r.entry.key}
          id={domId(r.entry.key)}
          entryKey={r.entry.key}
          stableId={r.id}
          label={r.entry.label}
          number={r.entry.number}
          level={r.entry.level}
          words={r.words}
          pagesText={pageRangeText(r.pages)}
          pagesSpoken={pageRangeSpoken(r.pages)}
          hasChildren={r.hasChildren}
          expanded={r.expanded}
          current={r.entry.key === currentKey}
          focusable={r.entry.key === tabKey}
          disabled={rewriteOpen}
          pos={r.pos}
          size={r.size}
          onActivate={activate}
          onToggle={toggle}
          onFocusRow={setFocusKey}
        />
      ))}
    </div>
  )
  return (
    <>
      {tree}
      {data.outline.chapters.length === 0 ? (
        <p className="px-3 py-2 text-ui-sm text-text-muted" data-testid="outline-empty">
          No chapters yet. Give a chapter heading the Chapter Title style to list it here.
        </p>
      ) : null}
    </>
  )
}

/** The foot: the manuscript's total word count (and its pages), as the status bar counts. */
function PaneFoot() {
  const words = useStore((s) => s.wordCount.document.total.words)
  const ready = useStore((s) => s.wordCount.ready)
  const pageCount = useStore((s) => s.layout.pageCount)
  if (!ready) return null
  return (
    <div className="shrink-0 border-t border-border px-3 py-1.5 text-ui-xs tabular-nums text-text-muted" data-testid="outline-total">
      <span className="font-medium text-text">{wordsText(words)}</span>
      {pageCount > 0 ? ` · ${formatCount(pageCount)} ${pageCount === 1 ? 'page' : 'pages'}` : ''}
    </div>
  )
}

/** The drag / arrow-key handle on the pane's inner edge (docked layout only). */
function ResizeHandle({ width, onWidth }: { width: number; onWidth: (px: number, commit: boolean) => void }) {
  const drag = useRef<{ x: number; w: number } | null>(null)
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    drag.current = { x: e.clientX, w: width }
    e.currentTarget.setPointerCapture?.(e.pointerId)
  }
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return
    onWidth(clampNavPaneWidth(drag.current.w + e.clientX - drag.current.x), false)
  }
  const end = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return
    onWidth(clampNavPaneWidth(drag.current.w + e.clientX - drag.current.x), true)
    drag.current = null
  }
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? RESIZE_STEP_LARGE : RESIZE_STEP
    const to =
      e.key === 'ArrowLeft' ? width - step : e.key === 'ArrowRight' ? width + step : e.key === 'Home' ? NAV_PANE_MIN_WIDTH : e.key === 'End' ? NAV_PANE_MAX_WIDTH : null
    if (to === null) return
    e.preventDefault()
    onWidth(clampNavPaneWidth(to), true)
  }
  return (
    <Tooltip side="right">
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={C.resize.label}
        aria-valuenow={width}
        aria-valuemin={NAV_PANE_MIN_WIDTH}
        aria-valuemax={NAV_PANE_MAX_WIDTH}
        data-control-id={C.resize.id}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={end}
        onPointerCancel={end}
        onKeyDown={onKeyDown}
        // 32px wide hit area straddling the edge (touch), a hairline drawn in its middle.
        className={cn('absolute inset-y-0 -right-4 z-10 w-8 cursor-col-resize touch-none', 'after:absolute after:inset-y-0 after:left-1/2 after:w-px after:bg-border hover:after:w-0.5 hover:after:bg-border-control', focusRing)}
      />
    </Tooltip>
  )
}

/**
 * View ▸ Navigation Pane (Word's Navigation Pane, Headings): docked at the left of the pages (comments
 * use the right margin), resizable and closable, its open state and width kept in preferences.json. In
 * a narrow window it floats over the pages instead. Mount once, as AppShell's `navigation`.
 */
export function NavigationPane() {
  const open = useStore((s) => s.preferences.navigationPane)
  const storedWidth = useStore((s) => s.preferences.navigationPaneWidth)
  const setPref = useStore((s) => s.preferencesActions.set)
  const { overlay, dismissed } = usePresentation()
  const [dragWidth, setDragWidth] = useState<number | null>(null)
  if (!open || dismissed) return null
  const width = dragWidth ?? storedWidth
  const onWidth = (px: number, commit: boolean) => {
    if (commit) {
      setDragWidth(null)
      setPref('navigationPaneWidth', px)
    } else setDragWidth(px)
  }
  return (
    <aside
      {...{ [PANE_ATTR]: '' }}
      aria-label="Navigation"
      data-testid="navigation-pane"
      data-overlay={overlay ? 'true' : undefined}
      style={{ width: overlay ? `min(${width}px, calc(100vw - 3rem))` : width }}
      className={cn(
        'flex min-h-0 shrink-0 flex-col border-r border-border bg-surface-raised text-text',
        overlay ? 'absolute inset-y-0 left-0 z-30 shadow-raised' : 'relative',
      )}
    >
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1">
        <h2 className="flex-1 px-1 text-ui font-semibold">Navigation</h2>
        <Tooltip side="bottom">
          <IconButton label={C.close.label} data-control-id={C.close.id} onClick={() => closeNavigationPane()}>
            <CloseIcon />
          </IconButton>
        </Tooltip>
      </div>
      {/* Word's pane has Headings / Pages / Results tabs; Headings is the one here. */}
      <h3 className="shrink-0 px-3 pt-2 pb-1 text-ui-xs font-semibold uppercase tracking-wide text-text-muted">Headings</h3>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <HeadingsTree overlay={overlay} />
      </div>
      <PaneFoot />
      {overlay ? null : <ResizeHandle width={width} onWidth={onWidth} />}
    </aside>
  )
}
