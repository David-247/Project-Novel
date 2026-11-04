import { shortcutParts, type ShortcutSpec } from '@/shared/ui'
import { isCommandEnabled, type Command, type MenuId } from './registry'

/**
 * Menu structure built from the registry, shared by the in-app menu bar and the native macOS menu
 * (the same labels, order and shortcuts on both).
 */
export type MenuNode =
  | { kind: 'item'; command: Command }
  | { kind: 'separator' }
  | { kind: 'submenu'; id: string; label: string; children: MenuNode[] }
  /** An OS-provided item of the native macOS menu (Services, Hide, the clipboard items). */
  | { kind: 'predefined'; name: PredefinedItem }

export type PredefinedItem = 'services' | 'hide' | 'hideOthers' | 'showAll' | 'cut' | 'copy' | 'paste' | 'selectAll'

export interface MenuModel {
  id: MenuId
  label: string
  /** Alt+<letter> opens this menu in the in-app menu bar (lower-case; a letter of `label`). */
  mnemonic: string
  children: MenuNode[]
}

/** 'in-app': the themed menu bar (Windows, web). 'mac-native': the macOS global menu bar. */
export type MenuLayout = 'in-app' | 'mac-native'

export const MENU_LABELS: Record<MenuId, { label: string; mnemonic: string }> = {
  app: { label: 'Novel', mnemonic: 'n' },
  file: { label: 'File', mnemonic: 'f' },
  edit: { label: 'Edit', mnemonic: 'e' },
  view: { label: 'View', mnemonic: 'v' },
  insert: { label: 'Insert', mnemonic: 'i' },
  format: { label: 'Format', mnemonic: 'o' },
  review: { label: 'Review', mnemonic: 'r' },
  help: { label: 'Help', mnemonic: 'h' },
}

const IN_APP_ORDER: MenuId[] = ['file', 'edit', 'view', 'insert', 'format', 'review', 'help']
const MAC_ORDER: MenuId[] = ['app', ...IN_APP_ORDER]

/** Commands the macOS menu leaves to the OS (they act on whatever has focus, text fields included). */
export const NATIVE_ROLES: Readonly<Record<string, PredefinedItem>> = {
  'edit.cut': 'cut',
  'edit.copy': 'copy',
  'edit.paste': 'paste',
  'edit.select_all': 'selectAll',
}

/** Offset that puts app-menu items after everything else when they move into File or Help. */
const MOVED_ORDER = 100_000

/** `data-control-id` of a submenu trigger: `menu.<menu>.<label slug>`. */
export function submenuControlId(menu: MenuId, label: string): string {
  return `menu.${menu}.${label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`
}

/** `data-control-id` of a top-level menu trigger. */
export const menuControlId = (menu: MenuId) => `menu.${menu}`

interface Placed {
  command: Command
  menu: MenuId
  group: string
  order: number
  submenu?: string
}

function place(cmd: Command, layout: MenuLayout): Placed | null {
  const m = cmd.menu
  if (!m) return null
  if (m.id !== 'app' || layout === 'mac-native') return { command: cmd, menu: m.id, group: m.group, order: m.order, submenu: m.submenu }
  // No app menu: About goes to the end of Help, the rest (Settings, Quit) to the end of File.
  return { command: cmd, menu: m.group === 'about' ? 'help' : 'file', group: `app:${m.group}`, order: m.order + MOVED_ORDER, submenu: m.submenu }
}

function byOrder(a: { order: number; label: string }, b: { order: number; label: string }) {
  return a.order - b.order || a.label.localeCompare(b.label)
}

function buildMenu(menu: MenuId, placed: Placed[], layout: MenuLayout): MenuNode[] {
  const groups = new Map<string, Placed[]>()
  for (const p of placed) groups.set(p.group, [...(groups.get(p.group) ?? []), p])
  const ordered = [...groups.values()].sort((a, b) => Math.min(...a.map((p) => p.order)) - Math.min(...b.map((p) => p.order)))
  const out: MenuNode[] = []
  ordered.forEach((group, gi) => {
    if (gi > 0) out.push({ kind: 'separator' })
    // Items and submenus in one ordered list; a submenu sits at its lowest item's order.
    const entries: { order: number; label: string; node: MenuNode }[] = []
    const subs = new Map<string, Placed[]>()
    for (const p of group) {
      if (p.submenu) subs.set(p.submenu, [...(subs.get(p.submenu) ?? []), p])
      else entries.push({ order: p.order, label: p.command.label, node: itemNode(p.command, layout) })
    }
    for (const [label, items] of subs) {
      const children = items
        .map((p) => ({ order: p.order, label: p.command.label, node: itemNode(p.command, layout) }))
        .sort(byOrder)
        .map((e) => e.node)
      entries.push({ order: Math.min(...items.map((p) => p.order)), label, node: { kind: 'submenu', id: submenuControlId(menu, label), label, children } })
    }
    out.push(...entries.sort(byOrder).map((e) => e.node))
  })
  if (menu === 'app' && layout === 'mac-native') return withMacAppItems(out)
  return out
}

function itemNode(command: Command, layout: MenuLayout): MenuNode {
  const role = layout === 'mac-native' ? NATIVE_ROLES[command.id] : undefined
  return role ? { kind: 'predefined', name: role } : { kind: 'item', command }
}

/** macOS app menu: the app's items, then Services and Hide / Hide Others / Show All before the last group (Quit). */
function withMacAppItems(nodes: MenuNode[]): MenuNode[] {
  const lastSep = nodes.map((n) => n.kind).lastIndexOf('separator')
  const head = lastSep >= 0 ? nodes.slice(0, lastSep) : []
  const tail = lastSep >= 0 ? nodes.slice(lastSep + 1) : nodes
  const os: MenuNode[] = [
    { kind: 'predefined', name: 'services' },
    { kind: 'separator' },
    { kind: 'predefined', name: 'hide' },
    { kind: 'predefined', name: 'hideOthers' },
    { kind: 'predefined', name: 'showAll' },
  ]
  const sep: MenuNode = { kind: 'separator' }
  return [...head, ...(head.length ? [sep] : []), ...os, ...(tail.length ? [sep] : []), ...tail]
}

/**
 * The menus for `layout`, in menu bar order. A menu with no commands is left out (the Review menu
 * appears once a revision tool registers its commands).
 */
export function buildMenuModel(commands: readonly Command[], layout: MenuLayout): MenuModel[] {
  const placed = commands.map((c) => place(c, layout)).filter((p): p is Placed => p !== null)
  const order = layout === 'mac-native' ? MAC_ORDER : IN_APP_ORDER
  return order
    .map((id) => ({ id, ...MENU_LABELS[id], children: buildMenu(id, placed.filter((p) => p.menu === id), layout) }))
    .filter((m) => m.children.length > 0)
}

// ---- Native menu snapshot (sent to Rust, src-tauri/src/menu.rs) ----------------------------------

export type NativeMenuNode =
  | { kind: 'item'; id: string; label: string; accelerator?: string; enabled: boolean; checked?: boolean }
  | { kind: 'separator' }
  | { kind: 'submenu'; label: string; items: NativeMenuNode[] }
  | { kind: 'predefined'; name: PredefinedItem }

export interface NativeMenuSnapshot {
  menus: { id: MenuId; label: string; items: NativeMenuNode[] }[]
}

const ACCEL_KEYS: Record<string, string> = {
  '=': 'Equal',
  '-': 'Minus',
  '[': 'BracketLeft',
  ']': 'BracketRight',
  '\\': 'Backslash',
  '/': 'Slash',
  ',': 'Comma',
  '.': 'Period',
  ';': 'Semicolon',
  "'": 'Quote',
  '`': 'Backquote',
  enter: 'Enter',
  escape: 'Escape',
  tab: 'Tab',
  space: 'Space',
  backspace: 'Backspace',
  arrowup: 'ArrowUp',
  arrowdown: 'ArrowDown',
  arrowleft: 'ArrowLeft',
  arrowright: 'ArrowRight',
}

/** A ProseMirror shortcut spec as a Tauri accelerator: "Mod-Shift-e" -> "CmdOrCtrl+Shift+E". */
export function toAccelerator(spec: ShortcutSpec): string {
  const { modifiers, key } = shortcutParts(spec)
  const mods = modifiers.map((m) => ({ mod: 'CmdOrCtrl', ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', meta: 'Super' })[m])
  const k = ACCEL_KEYS[key.toLowerCase()] ?? (key.length === 1 ? key.toUpperCase() : key)
  return [...mods, k].join('+')
}

function nativeNodes(nodes: MenuNode[]): NativeMenuNode[] {
  return nodes.map((n): NativeMenuNode => {
    if (n.kind === 'separator' || n.kind === 'predefined') return n
    if (n.kind === 'submenu') return { kind: 'submenu', label: n.label, items: nativeNodes(n.children) }
    const c = n.command
    const item: NativeMenuNode = { kind: 'item', id: c.id, label: c.label, enabled: isCommandEnabled(c) }
    if (c.shortcut) item.accelerator = toAccelerator(c.shortcut)
    if (c.isChecked) item.checked = safe(c.isChecked)
    return item
  })
}

function safe(f: () => boolean): boolean {
  try {
    return f()
  } catch {
    return false
  }
}

/** The macOS menu as plain data with the current enabled/checked state. */
export function nativeMenuSnapshot(commands: readonly Command[]): NativeMenuSnapshot {
  return {
    menus: buildMenuModel(commands, 'mac-native').map((m) => ({ id: m.id, label: m.label, items: nativeNodes(m.children) })),
  }
}
