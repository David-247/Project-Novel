// Shared ribbon model (Phase 3, T6): the tabs and groups of the toolbar, and where commands go in it.
// Any slice may add to it without importing another slice; the ribbon slice renders it.
// See docs/design.md, "Ribbon".
//
// - Tabs are fixed: Home, Insert, Layout, Review, View (Word's names and order).
// - A group is registered once (registerRibbonGroups) with its tab, order, priority and icon. It shows
//   its `Content` (the slice's own controls) and/or the registry commands placed in it.
// - A command joins a group through its `ribbon` field (@/shared/commands): a labelled button in the
//   group, and an item of the group's dropdown when the group is collapsed or in the overflow.
// - A group with no content and no commands is not shown (e.g. Review > Changes until T7).
import { useSyncExternalStore } from 'react'
import type { ComponentType } from 'react'

export type RibbonTabId = 'home' | 'insert' | 'layout' | 'review' | 'view'

export const RIBBON_TABS: readonly { id: RibbonTabId; label: string; description: string }[] = [
  { id: 'home', label: 'Home', description: 'Font, paragraph, styles and find.' },
  { id: 'insert', label: 'Insert', description: 'Breaks between pages, chapters and scenes, and footnotes.' },
  { id: 'layout', label: 'Layout', description: 'Book size, headers and page numbers, paper and book details.' },
  { id: 'review', label: 'Review', description: 'Track changes and comments.' },
  { id: 'view', label: 'View', description: 'Page views, zoom, the comments panel and full screen.' },
]

/** One entry of a group's dropdown: a registry command, or a registry submenu (by menu and label). */
export type RibbonMenuEntry =
  | { cmd: string }
  | { submenu: { menu: 'file' | 'edit' | 'view' | 'insert' | 'format' | 'review'; label: string } }

/** How much room a group gets. `compact` only for groups with `hasCompact`. */
export type RibbonGroupSize = 'full' | 'compact'

export interface RibbonGroupSpec {
  /** `<tab>.<name>`, e.g. 'home.font'. Commands name it in `ribbon.group`. */
  id: string
  tab: RibbonTabId
  /** Word's group name where one fits ("Font", "Paragraph"); shown on the collapsed group button. */
  label: string
  /** Left-to-right position in the tab. */
  order: number
  /** Higher keeps its full size longer as the window narrows (ties: the rightmost shrinks first). */
  priority: number
  /** Icon of the collapsed group button (16-20px, currentColor). */
  icon: ComponentType
  /** The slice's own controls. Each focusable control must be a Radix toolbar item (`ToolbarItem`). */
  Content?: ComponentType<{ size: RibbonGroupSize }>
  hasCompact?: boolean
  /** Where the commands placed in the group go: after `Content` (default) or before it. */
  buttons?: 'before' | 'after'
  /** false: never shown as a dropdown (only moved into "More" at the narrowest widths). Default true. */
  collapsible?: boolean
  /** In compact size, a dropdown with these entries follows the content (what compact leaves out). */
  compactMenu?: { label: string; entries: RibbonMenuEntry[] }
  /** Dropdown entries when collapsed or in the overflow, before the commands placed in the group. */
  menu?: RibbonMenuEntry[]
}

const groups = new Map<string, RibbonGroupSpec>()
let snapshot: readonly RibbonGroupSpec[] = []
const listeners = new Set<() => void>()

function emit() {
  snapshot = [...groups.values()].sort((a, b) => a.order - b.order)
  listeners.forEach((l) => l())
}

/** Add groups; returns one unregister for all. A duplicate id throws (a programming error). */
export function registerRibbonGroups(list: readonly RibbonGroupSpec[]): () => void {
  for (const g of list) if (groups.has(g.id)) throw new Error(`registerRibbonGroups: duplicate group id "${g.id}"`)
  for (const g of list) groups.set(g.id, g)
  emit()
  return () => {
    for (const g of list) if (groups.get(g.id) === g) groups.delete(g.id)
    emit()
  }
}

export function getRibbonGroups(): readonly RibbonGroupSpec[] {
  return snapshot
}

export function getRibbonGroup(id: string): RibbonGroupSpec | undefined {
  return groups.get(id)
}

export function useRibbonGroups(): readonly RibbonGroupSpec[] {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    getRibbonGroups,
    getRibbonGroups,
  )
}

// ---- Selected tab: remembered for the session (it starts on Home when the app starts) ----------------

const TAB_KEY = 'nv.ribbon.tab'
const isTab = (v: unknown): v is RibbonTabId => RIBBON_TABS.some((t) => t.id === v)

function initialTab(): RibbonTabId {
  try {
    const v = sessionStorage.getItem(TAB_KEY)
    if (isTab(v)) return v
  } catch {
    /* storage blocked: start on Home */
  }
  return 'home'
}

let tab: RibbonTabId = initialTab()
const tabListeners = new Set<() => void>()

export function getRibbonTab(): RibbonTabId {
  return tab
}

export function setRibbonTab(next: RibbonTabId): void {
  if (next === tab) return
  tab = next
  try {
    sessionStorage.setItem(TAB_KEY, next)
  } catch {
    /* per-session convenience only */
  }
  tabListeners.forEach((l) => l())
}

export function useRibbonTab(): RibbonTabId {
  return useSyncExternalStore(
    (cb) => {
      tabListeners.add(cb)
      return () => tabListeners.delete(cb)
    },
    getRibbonTab,
    getRibbonTab,
  )
}

/** Control ids of the ribbon's own controls (tooltips registry). */
export const ribbonTabControlId = (id: RibbonTabId) => `ribbon.tab.${id}`
export const ribbonGroupControlId = (groupId: string) => `ribbon.group.${groupId}`
export const ribbonCompactControlId = (groupId: string) => `ribbon.compact.${groupId}`
export const RIBBON_MORE_ID = 'ribbon.more'
/**
 * A registry command's ribbon button: its own id, so it never clashes with the same command's menu
 * item or another control for it (e.g. the status bar's zoom buttons). Tooltip copy is the command's.
 */
export const RIBBON_COMMAND_PREFIX = 'ribbon.cmd.'
export const ribbonCommandControlId = (commandId: string) => `${RIBBON_COMMAND_PREFIX}${commandId}`

/** Test-only. */
export function __resetRibbonForTests(): void {
  groups.clear()
  tab = 'home'
  emit()
}
