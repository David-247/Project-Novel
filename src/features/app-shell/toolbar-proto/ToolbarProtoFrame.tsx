import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { getCommand, isCommandEnabled, useCommandStateVersion, useCommands } from '@/shared/commands'
import { cn, focusRing } from '@/shared/ui'
import { Chevron, CommandMenu, type MenuSection } from './CommandMenu'
import {
  groupByLabel,
  PROTO_GROUPS,
  PROTO_TABS,
  PROTO_UNITS,
  VIEW_TAB_ENTRIES,
  type ProtoTab,
  type ToolbarProtoMode,
} from './groups'
import './toolbar-proto.css'

/**
 * T6 step 1: three switchable single-row toolbar prototypes around the shipping toolbar (dev flag
 * `?toolbar=overflow|tabs|groups`). The toolbar's own DOM is left as it is; the frame measures the
 * row (ResizeObserver + scrollWidth) and hides whole `ToolbarGroup`s with a `data-proto-hidden`
 * attribute, then offers their commands from the command registry in a dropdown. Hysteresis: a
 * collapsed group comes back only when it fits with 24px to spare.
 */

const HYSTERESIS_PX = 24

/** Short names for the per-group dropdowns of the ribbon prototype. */
const SHORT: Record<string, string> = {
  'Text style': 'Text',
  'Spacing and indent': 'Spacing',
  'Book layout': 'Book',
  App: 'Settings',
}

interface ProtoState {
  hidden: Set<string>
  shownPh: Set<string>
  brand: boolean
  icons: boolean
}

type Step = ProtoState

/** The dropdown placeholder that stands in for a collapsed group in this mode, if any. */
function placeholderFor(mode: ToolbarProtoMode, label: string): string | null {
  if (mode === 'tabs') return label
  if (mode === 'groups') return PROTO_UNITS.find((u) => u.glyph && u.groups.includes(label))?.id ?? null
  return null
}

/** Collapsed groups that no visible dropdown stands in for: they go to "More". */
function inMore(mode: ToolbarProtoMode, s: ProtoState): string[] {
  return [...s.hidden].filter((l) => {
    const ph = placeholderFor(mode, l)
    return !ph || !s.shownPh.has(ph)
  })
}

const directGroups = (root: Element) =>
  Array.from(root.children).filter((c): c is HTMLElement => c.getAttribute('role') === 'group' && c.hasAttribute('aria-label'))

function applyState(mode: ToolbarProtoMode, root: HTMLElement, row: HTMLElement, s: ProtoState, offtab: Set<string>) {
  for (const child of Array.from(root.children) as HTMLElement[]) {
    const role = child.getAttribute('role')
    const ph = child.getAttribute('data-proto-ph')
    let hide = false
    if (ph !== null) hide = !s.shownPh.has(ph)
    else if (role === 'group') {
      const label = child.getAttribute('aria-label') ?? ''
      hide = s.hidden.has(label) || offtab.has(label)
    }
    if (role === 'separator') hide = true
    child.toggleAttribute('data-proto-hidden', hide)
  }
  // A separator shows only between two visible items.
  let seenContent = false
  let pending: HTMLElement | null = null
  for (const child of Array.from(root.children) as HTMLElement[]) {
    if (child.getAttribute('role') === 'separator') {
      if (seenContent && !pending) pending = child
    } else if (!child.hasAttribute('data-proto-hidden')) {
      if (pending) pending.removeAttribute('data-proto-hidden')
      pending = null
      seenContent = true
    }
  }
  row.querySelector('[data-proto-brand]')?.toggleAttribute('data-proto-hidden', !s.brand)
  row.toggleAttribute('data-proto-icons', s.icons)
  const more = row.querySelector('[data-proto-more]')
  more?.toggleAttribute('data-proto-hidden', inMore(mode, s).length === 0)
}

/** The collapse sequence for a mode: step 0 shows everything, each later step collapses one more thing. */
function steps(mode: ToolbarProtoMode, tab: ProtoTab, present: Set<string>): Step[] {
  const out: Step[] = []
  const base = (): Step => ({ hidden: new Set(), shownPh: new Set(), brand: true, icons: false })
  out.push(base())
  const s1 = { ...base(), brand: false }
  out.push(s1)
  let prev = s1
  if (mode === 'overflow') {
    const order = PROTO_GROUPS.filter((g) => present.has(g.label)).sort((a, b) => a.priority - b.priority)
    for (const g of order) {
      const next = { ...prev, hidden: new Set([...prev.hidden, g.label]) }
      out.push(next)
      prev = next
    }
  } else if (mode === 'groups') {
    const order = PROTO_UNITS.filter((u) => u.glyph && u.groups.some((l) => present.has(l))).sort((a, b) => a.priority - b.priority)
    for (const u of order) {
      const next = { ...prev, hidden: new Set([...prev.hidden, ...u.groups]), shownPh: new Set([...prev.shownPh, u.id]) }
      out.push(next)
      prev = next
    }
    prev = { ...prev, icons: true }
    out.push(prev)
  } else {
    const order = PROTO_GROUPS.filter((g) => g.tab === tab && present.has(g.label)).sort((a, b) => a.priority - b.priority)
    for (const g of order) {
      const next = { ...prev, hidden: new Set([...prev.hidden, g.label]), shownPh: new Set([...prev.shownPh, g.label]) }
      out.push(next)
      prev = next
    }
  }
  // Last resort (narrowest widths): the dropdowns themselves move into "More", lowest priority first.
  if (mode !== 'overflow') {
    const units =
      mode === 'groups'
        ? PROTO_UNITS.filter((u) => u.glyph && u.groups.some((l) => present.has(l))).sort((a, b) => a.priority - b.priority).map((u) => u.id)
        : PROTO_GROUPS.filter((g) => g.tab === tab && present.has(g.label)).sort((a, b) => a.priority - b.priority).map((g) => g.label)
    for (const id of units) {
      const shownPh = new Set(prev.shownPh)
      shownPh.delete(id)
      prev = { ...prev, shownPh }
      out.push(prev)
    }
  }
  return out
}

export function ToolbarProtoFrame({ mode, children }: { mode: ToolbarProtoMode; children: ReactNode }) {
  const rowRef = useRef<HTMLDivElement>(null)
  const [tab, setTab] = useState<ProtoTab>('home')
  const [placeholders, setPlaceholders] = useState<Map<string, HTMLElement>>(new Map())
  const [state, setState] = useState<ProtoState | null>(null)
  const count = useRef(0)

  const root = () => rowRef.current?.querySelector<HTMLElement>('[role="toolbar"]') ?? null

  // Placeholders for the dropdown buttons: before the first group of each unit (groups) or each group (tabs).
  useLayoutEffect(() => {
    const r = root()
    if (!r || mode === 'overflow') return
    const map = new Map<string, HTMLElement>()
    const groups = directGroups(r)
    const add = (key: string, before: HTMLElement | undefined) => {
      if (!before) return
      const span = document.createElement('span')
      span.setAttribute('data-proto-ph', key)
      span.setAttribute('data-proto-hidden', '')
      span.className = 'inline-flex shrink-0'
      r.insertBefore(span, before)
      map.set(key, span)
    }
    if (mode === 'groups') {
      for (const u of PROTO_UNITS) if (u.glyph) add(u.id, groups.find((g) => u.groups.includes(g.getAttribute('aria-label') ?? '')))
    } else {
      for (const g of groups) {
        const label = g.getAttribute('aria-label') ?? ''
        if (groupByLabel.get(label)?.tab !== 'always') add(label, g)
      }
    }
    // The portal targets are DOM nodes made here, outside React: rendering into them needs a re-render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPlaceholders(map)
    return () => map.forEach((el) => el.remove())
  }, [mode])

  const layout = useCallback(() => {
    const row = rowRef.current
    const r = root()
    if (!row || !r) return
    const present = new Set(directGroups(r).map((g) => g.getAttribute('aria-label') ?? ''))
    const offtab = new Set<string>()
    if (mode === 'tabs') for (const g of PROTO_GROUPS) if (g.tab !== 'always' && g.tab !== tab) offtab.add(g.label)
    const seq = steps(mode, tab, present)
    const fits = (slack: number) => r.scrollWidth + slack <= r.clientWidth + 1 && row.scrollWidth <= row.clientWidth + 1
    const first = (slack: number) => {
      for (let i = 0; i < seq.length; i++) {
        applyState(mode, r, row, seq[i], offtab)
        if (fits(slack)) return i
      }
      return seq.length - 1
    }
    let n = first(0)
    if (n < count.current) n = Math.min(count.current, first(HYSTERESIS_PX))
    count.current = n
    applyState(mode, r, row, seq[n], offtab)
    setState(seq[n])
  }, [mode, tab])

  useLayoutEffect(() => {
    count.current = 0
    layout()
    const row = rowRef.current
    if (!row) return
    const ro = new ResizeObserver(() => layout())
    ro.observe(row)
    // Late width changes: web fonts, the installed-font list, the style list.
    const t = setTimeout(layout, 400)
    void document.fonts?.ready.then(() => layout())
    return () => {
      ro.disconnect()
      clearTimeout(t)
    }
  }, [layout, placeholders])

  const more = new Set(state ? inMore(mode, state) : [])
  const moreSections: MenuSection[] = PROTO_GROUPS.filter((g) => more.has(g.label)).map((g) => ({
    title: g.label,
    entries: g.entries,
    missing: g.missing,
  }))

  const portals = [...placeholders].map(([key, el]) => {
    if (mode === 'groups') {
      const u = PROTO_UNITS.find((x) => x.id === key)!
      const sections = u.groups.map((l) => groupByLabel.get(l)!).map((g) => ({ title: g.label, entries: g.entries, missing: g.missing }))
      return createPortal(
        <CommandMenu
          controlId={`toolbarProto.group.${u.id}`}
          label={u.label}
          sections={sections}
          trigger={
            <>
              <span data-proto-label>{u.label}</span>
              <span data-proto-glyph className="inline-flex size-5 items-center justify-center" aria-hidden="true">
                <UnitIcon id={u.id} />
              </span>
              <Chevron />
            </>
          }
        />,
        el,
        key,
      )
    }
    const g = groupByLabel.get(key)!
    return createPortal(
      <CommandMenu
        controlId={`toolbarProto.group.${key}`}
        label={g.label}
        sections={[{ title: g.label, entries: g.entries, missing: g.missing }]}
        trigger={
          <>
            <span>{SHORT[g.label] ?? g.label}</span>
            <Chevron />
          </>
        }
      />,
      el,
      key,
    )
  })

  const row = (
    <div ref={rowRef} data-toolbar-proto-mode={mode} className="flex h-control-lg min-w-0 flex-1 items-center gap-1 overflow-hidden">
      {children}
      {mode === 'tabs' && tab === 'view' ? <ViewTabButtons /> : null}
      {portals}
      <div data-proto-more data-proto-hidden="" className="shrink-0 border-l border-border pl-1">
        <CommandMenu
          controlId="toolbarProto.more"
          label="More tools"
          align="end"
          sections={moreSections}
          trigger={
            <>
              <span>More</span>
              <Chevron />
            </>
          }
        />
      </div>
    </div>
  )

  if (mode !== 'tabs') return row
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div role="tablist" aria-label="Toolbar tabs" className="flex h-7 shrink-0 items-end gap-0.5 overflow-hidden">
        {PROTO_TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            data-control-id={`toolbarProto.tab.${t.id}`}
            onClick={() => setTab(t.id)}
            className={cn(
              'h-7 shrink-0 rounded-t-control border-b-2 px-3 text-ui-sm',
              tab === t.id ? 'border-accent font-semibold text-accent' : 'border-transparent text-text-muted hover:text-text',
              focusRing,
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      {row}
    </div>
  )
}

/** Ribbon View tab: the registry's View commands as text buttons (pressed when checked). */
function ViewTabButtons() {
  useCommands()
  useCommandStateVersion()
  return (
    <div role="group" aria-label="View" className="flex shrink-0 items-center gap-0.5">
      {VIEW_TAB_ENTRIES.map((e) => {
        if (!('cmd' in e)) return null
        const c = getCommand(e.cmd)
        if (!c) return null
        let checked: boolean | undefined
        try {
          checked = c.isChecked?.()
        } catch {
          checked = false
        }
        return (
          <button
            key={c.id}
            type="button"
            data-control-id={`toolbarProto.view.${c.id}`}
            title={c.description}
            aria-pressed={checked}
            disabled={!isCommandEnabled(c)}
            onClick={() => c.run()}
            className={cn(
              'inline-flex h-control shrink-0 items-center rounded-control px-2 text-ui-sm text-text hover:bg-surface-hover disabled:text-text-muted',
              checked && 'bg-accent-soft text-accent',
              focusRing,
            )}
          >
            {c.label}
          </button>
        )
      })}
    </div>
  )
}

/** Icons for the narrowest "groups" step (prototype quality; step 2 would reuse the toolbar icon set). */
function UnitIcon({ id }: { id: string }) {
  const common = { viewBox: '0 0 20 20', className: 'size-5', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }
  switch (id) {
    case 'font':
      return (
        <svg {...common}>
          <path d="M4 16L9 4h1l5 12M6 12h7" />
        </svg>
      )
    case 'paragraph':
      return (
        <svg {...common}>
          <path d="M3 5h14M3 9h14M3 13h14M3 17h9" />
        </svg>
      )
    case 'styles':
      return (
        <svg {...common}>
          <path d="M3 15l3.5-9h1L11 15M4.3 12h4.4M13 10.5c.6-.6 1.3-.9 2.1-.9 1.3 0 1.9.7 1.9 1.9V15M17 12.6c-2.8 0-4 .6-4 1.4 0 .7.6 1.1 1.4 1.1 1.4 0 2.6-1 2.6-2.5" />
        </svg>
      )
    case 'insert':
      return (
        <svg {...common}>
          <path d="M10 4v12M4 10h12" />
        </svg>
      )
    case 'review':
      return (
        <svg {...common}>
          <path d="M4 16l1-4 8-8 3 3-8 8-4 1zM11.5 5.5l3 3" />
        </svg>
      )
    default:
      return (
        <svg {...common}>
          <path d="M5 3h7l3 3v11H5zM12 3v3h3M7.5 10h5M7.5 13h5" />
        </svg>
      )
  }
}
