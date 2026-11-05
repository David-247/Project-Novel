import * as RToolbar from '@radix-ui/react-toolbar'
import { Fragment, useCallback, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import { getEditor } from '@/features/editor'
import { isCommandEnabled, useCommands, useCommandStateVersion, type Command } from '@/shared/commands'
import {
  RIBBON_MORE_ID,
  RIBBON_TABS,
  ribbonCommandControlId,
  ribbonCompactControlId,
  ribbonGroupControlId,
  ribbonTabControlId,
  setRibbonTab,
  useRibbonGroups,
  useRibbonTab,
  type RibbonGroupSpec,
  type RibbonMenuEntry,
  type RibbonTabId,
} from '@/shared/ribbon'
import { cn, controlBase, focusRing, ToolbarSeparator, Tooltip } from '@/shared/ui'
import { chooseStep, ribbonSteps, type GroupState } from './layout'
import { Chevron, RegistryMenu, type MenuSection } from './RegistryMenu'

/**
 * The toolbar: a Word-style ribbon. Tabs (Home, Insert, Layout, Review, View) over one row of groups.
 * The row never wraps and never changes height: groups scale down as the window narrows (see
 * layout.ts), and everything stays reachable through collapsed group buttons and the "More" menu.
 *
 * One Radix toolbar holds the tab buttons and the active tab's controls: arrow keys move through both,
 * Tab enters and leaves, Escape on a control returns to the manuscript. Inactive tabs and collapsed
 * groups stay mounted (hidden), so their dialogs and state survive a tab switch.
 */

type Placed = ReadonlyMap<string, readonly Command[]>

function placedCommands(commands: readonly Command[]): Placed {
  const map = new Map<string, Command[]>()
  for (const c of commands) {
    if (!c.ribbon) continue
    map.set(c.ribbon.group, [...(map.get(c.ribbon.group) ?? []), c])
  }
  for (const list of map.values()) list.sort((a, b) => a.ribbon!.order - b.ribbon!.order)
  return map
}

/** Dropdown entries of a group: its own `menu`, then the commands placed in it (no repeats). */
function groupEntries(g: RibbonGroupSpec, placed: Placed): RibbonMenuEntry[] {
  const own = g.menu ?? []
  const listed = new Set(own.flatMap((e) => ('cmd' in e ? [e.cmd] : [])))
  return [...own, ...(placed.get(g.id) ?? []).filter((c) => !listed.has(c.id)).map((c) => ({ cmd: c.id }))]
}

const buttons = (g: RibbonGroupSpec, placed: Placed) => (placed.get(g.id) ?? []).filter((c) => c.ribbon?.display !== 'menu')

/**
 * A registry command as a labelled ribbon button (pressed when the command is checked). Enabled and
 * checked are read on every render; renders follow the registry's debounced state signal (at most
 * COMMAND_STATE_DEBOUNCE_MS late after a change made elsewhere, e.g. a shortcut), and the button
 * re-renders at once after its own click.
 */
function CommandButton({ command }: { command: Command }) {
  useCommandStateVersion()
  const [, clicked] = useReducer((n: number) => n + 1, 0)
  const enabled = isCommandEnabled(command)
  let checked: boolean | undefined
  try {
    checked = command.isChecked?.()
  } catch {
    checked = false
  }
  return (
    <RToolbar.Button asChild disabled={!enabled}>
      <Tooltip controlId={ribbonCommandControlId(command.id)}>
        <button
          type="button"
          data-control-id={ribbonCommandControlId(command.id)}
          aria-pressed={command.isChecked ? !!checked : undefined}
          disabled={!enabled}
          // Keep the manuscript's focus and selection on a pointer press (the command acts there).
          onMouseDown={(e) => {
            if (e.button === 0) e.preventDefault()
          }}
          onClick={() => {
            if (isCommandEnabled(command)) command.run()
            clicked()
          }}
          className={cn(
            controlBase,
            'whitespace-nowrap px-2 font-normal',
            checked ? 'bg-accent-soft text-accent' : 'text-text hover:bg-surface-hover',
          )}
        >
          {command.label.replace(/…$/, '')}
        </button>
      </Tooltip>
    </RToolbar.Button>
  )
}

function GroupView({ group, state, placed }: { group: RibbonGroupSpec; state: GroupState; placed: Placed }) {
  const shown = state === 'full' || state === 'compact'
  const Content = group.Content
  const Icon = group.icon
  // In compact size a group may leave its command buttons out (its own control then offers them).
  const ownButtons =
    state === 'compact' && group.compactButtons === false ? [] : buttons(group, placed).map((c) => <CommandButton key={c.id} command={c} />)
  return (
    <div
      role="group"
      aria-label={group.label}
      data-ribbon-group={group.id}
      data-ribbon-state={state}
      className={cn('flex shrink-0 items-center gap-0.5', state === 'overflow' && 'hidden')}
    >
      {/* Mounted at every size (hidden when collapsed): the group's dialogs and state live here. */}
      <div className="flex shrink-0 items-center gap-0.5" hidden={!shown}>
        {group.buttons === 'before' ? ownButtons : null}
        {Content ? <Content size={state === 'compact' ? 'compact' : 'full'} /> : null}
        {group.buttons === 'before' ? null : ownButtons}
        {state === 'compact' && group.compactMenu ? (
          <RegistryMenu
            controlId={ribbonCompactControlId(group.id)}
            label={group.compactMenu.label}
            sections={[{ title: group.compactMenu.label, entries: group.compactMenu.entries }]}
            trigger={
              <>
                <span>{group.compactMenu.label}</span>
                <Chevron />
              </>
            }
          />
        ) : null}
      </div>
      {state === 'collapsed' ? (
        <RegistryMenu
          controlId={ribbonGroupControlId(group.id)}
          label={group.label}
          sections={[{ title: group.label, entries: groupEntries(group, placed) }]}
          trigger={
            <>
              <span className="inline-flex size-4 items-center justify-center text-text-muted" aria-hidden="true">
                <Icon />
              </span>
              <span>{group.label}</span>
              <Chevron />
            </>
          }
        />
      ) : null}
    </div>
  )
}

/** Narrower gaps between groups than the shared toolbar separator (room for one more group). */
const SEPARATOR = { marginInline: 4 }

/** Width of a collapsed group button: icon, label and chevron (close enough to decide what to collapse). */
const collapsedWidthEstimate = (label: string) => 52 + label.length * 7.5

/** Groups of a tab that have something to show. */
function tabGroups(all: readonly RibbonGroupSpec[], tab: RibbonTabId, placed: Placed) {
  return all.filter((g) => g.tab === tab && (g.Content || buttons(g, placed).length > 0 || groupEntries(g, placed).length > 0))
}

function TabPanel({ tab, active, groups, placed }: { tab: RibbonTabId; active: boolean; groups: RibbonGroupSpec[]; placed: Placed }) {
  const outer = useRef<HTMLDivElement>(null)
  const inner = useRef<HTMLDivElement>(null)
  // Full widths of the groups (measured at step 0): a group whose dropdown button would be as wide as
  // its own controls (one or two buttons) never collapses; it only moves into "More".
  const [fullWidths, setFullWidths] = useState<Readonly<Record<string, number>>>({})
  const steps = useMemo(
    () =>
      ribbonSteps(
        groups.map((g) => ({
          id: g.id,
          order: g.order,
          priority: g.priority,
          hasCompact: g.hasCompact,
          collapsible: g.collapsible !== false && !(fullWidths[g.id] !== undefined && fullWidths[g.id] <= collapsedWidthEstimate(g.label)),
        })),
      ),
    [groups, fullWidths],
  )
  const [step, setStep] = useState(0)
  const widths = useRef<(number | undefined)[]>([])
  const measuredStep = useRef(-1)
  const [tick, setTick] = useState(0)
  const bump = useCallback(() => setTick((t) => t + 1), [])

  // A different set of groups: every width is unknown again.
  useLayoutEffect(() => {
    widths.current = []
    measuredStep.current = -1
  }, [steps])

  // After each render: record the natural width of the shown step, then move to the step that fits.
  useLayoutEffect(() => {
    if (!active || !outer.current || !inner.current) return
    const cur = Math.min(step, steps.length - 1)
    widths.current[cur] = inner.current.offsetWidth
    if (cur === 0) {
      const measured: Record<string, number> = {}
      for (const el of inner.current.querySelectorAll<HTMLElement>('[data-ribbon-group]')) measured[el.dataset.ribbonGroup!] = el.offsetWidth
      const changed = Object.keys(measured).some((id) => Math.abs((fullWidths[id] ?? -99) - measured[id]) > 2)
      // eslint-disable-next-line react-hooks/set-state-in-effect -- measured layout feeds the next render (before paint)
      if (changed) setFullWidths(measured)
    }
    measuredStep.current = cur
    const next = chooseStep(widths.current, cur, outer.current.clientWidth, steps.length)
    if (next.step !== cur) setStep(next.step)
  }, [active, step, steps, tick, fullWidths])

  useLayoutEffect(() => {
    if (!active || !outer.current || !inner.current) return
    let lastInner = inner.current.offsetWidth
    const ro = new ResizeObserver(() => {
      const w = inner.current?.offsetWidth ?? 0
      // The content itself changed width at the same step (fonts, a style name): measure again.
      if (w !== lastInner && measuredStep.current === step) widths.current = []
      lastInner = w
      bump()
    })
    ro.observe(outer.current)
    ro.observe(inner.current)
    return () => ro.disconnect()
  }, [active, step, bump])

  const state = steps[Math.min(step, steps.length - 1)] ?? {}
  const visible = groups.filter((g) => state[g.id] !== 'overflow')
  const overflowed = groups.filter((g) => state[g.id] === 'overflow')
  const more: MenuSection[] = overflowed.map((g) => ({ title: g.label, entries: groupEntries(g, placed) }))

  return (
    <div
      ref={outer}
      role="tabpanel"
      id={`ribbon-panel-${tab}`}
      aria-labelledby={`ribbon-tab-${tab}`}
      hidden={!active}
      data-ribbon-panel={tab}
      data-ribbon-step={step}
      className="h-control-lg min-w-0 overflow-hidden"
    >
      <div ref={inner} className="flex h-full w-max items-center gap-0.5">
        {groups.map((g) => {
          const i = visible.indexOf(g)
          return (
            <Fragment key={g.id}>
              {i > 0 ? <ToolbarSeparator style={SEPARATOR} /> : null}
              <GroupView group={g} state={state[g.id] ?? 'full'} placed={placed} />
            </Fragment>
          )
        })}
        {overflowed.length > 0 ? (
          <>
            <ToolbarSeparator style={SEPARATOR} />
            <RegistryMenu
              controlId={RIBBON_MORE_ID}
              label="More"
              align="end"
              sections={more}
              trigger={
                <>
                  <svg aria-hidden="true" viewBox="0 0 20 20" className="size-5 text-text-muted">
                    <circle cx="4.5" cy="10" r="1.5" fill="currentColor" />
                    <circle cx="10" cy="10" r="1.5" fill="currentColor" />
                    <circle cx="15.5" cy="10" r="1.5" fill="currentColor" />
                  </svg>
                  <span>More</span>
                </>
              }
            />
          </>
        ) : null}
      </div>
    </div>
  )
}

export interface RibbonProps {
  /**
   * Word's Quick Access Toolbar: controls shown on every tab, left of the tabs (Undo / Redo). Wrap
   * focusable items as Radix toolbar items (`ToolbarItem`).
   */
  quickAccess?: ReactNode
}

export function Ribbon({ quickAccess }: RibbonProps = {}) {
  const all = useRibbonGroups()
  const commands = useCommands()
  const placed = useMemo(() => placedCommands(commands), [commands])
  const tab = useRibbonTab()
  const perTab = useMemo(
    () => Object.fromEntries(RIBBON_TABS.map((t) => [t.id, tabGroups(all, t.id, placed)])) as Record<RibbonTabId, RibbonGroupSpec[]>,
    [all, placed],
  )

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // Only the ribbon's own items: fields inside it handle Escape themselves.
    const target = e.target as HTMLElement
    if (e.defaultPrevented || !target.hasAttribute('data-radix-collection-item')) return
    if (e.key === 'Escape') {
      const ed = getEditor()
      if (!ed) return
      e.preventDefault()
      ed.commands.focus()
    }
  }

  return (
    <RToolbar.Root aria-label="Formatting" className="flex min-w-0 flex-1 flex-col" onKeyDown={onKeyDown}>
      <div className="flex h-8 shrink-0 items-end overflow-hidden">
        {quickAccess ? (
          <>
            <div role="group" aria-label="Quick access" className="flex shrink-0 items-center gap-0.5 self-center">
              {quickAccess}
            </div>
            <ToolbarSeparator style={SEPARATOR} className="self-center" />
          </>
        ) : null}
      <div role="tablist" aria-label="Ribbon tabs" className="flex h-8 min-w-0 items-end gap-0.5">
        {RIBBON_TABS.map((t) => (
          <RToolbar.Button asChild key={t.id}>
            <Tooltip>
              <button
                type="button"
                role="tab"
                id={`ribbon-tab-${t.id}`}
                aria-selected={tab === t.id}
                aria-controls={`ribbon-panel-${t.id}`}
                data-control-id={ribbonTabControlId(t.id)}
                // Like Word: choosing a tab with the pointer leaves the focus (and selection) in the text.
                onMouseDown={(e) => {
                  if (e.button === 0) e.preventDefault()
                }}
                onClick={() => setRibbonTab(t.id)}
                className={cn(
                  'relative h-8 min-w-control shrink-0 rounded-t-control px-3 text-ui-sm',
                  tab === t.id
                    ? 'font-semibold text-accent after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-accent'
                    : 'text-text-muted hover:bg-surface-hover hover:text-text',
                  focusRing,
                )}
              >
                {t.label}
              </button>
            </Tooltip>
          </RToolbar.Button>
        ))}
      </div>
      </div>
      {RIBBON_TABS.map((t) => (
        <TabPanel key={t.id} tab={t.id} active={tab === t.id} groups={perTab[t.id]} placed={placed} />
      ))}
    </RToolbar.Root>
  )
}
