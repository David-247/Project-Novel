/**
 * Keyboard shortcut specs, written once and rendered per platform.
 *
 * A spec uses Tiptap/ProseMirror notation: modifiers and key joined by "-" (or "+"), with
 * "Mod" meaning Cmd on macOS and Ctrl elsewhere: "Mod-b", "Mod-Shift-8", "Mod+Shift+Z", "Shift-Enter",
 * "Escape". A trailing "-" is the minus key ("Mod--").
 */
export type ShortcutSpec = string
export type Platform = 'mac' | 'other'

interface UADataNavigator {
  userAgentData?: { platform?: string }
}

/** The running platform: macOS/iOS use Cmd, everything else uses Ctrl. */
export function detectPlatform(): Platform {
  if (typeof navigator === 'undefined') return 'other'
  const ua = (navigator as Navigator & UADataNavigator).userAgentData?.platform || navigator.platform || ''
  return /mac|iphone|ipad|ipod/i.test(ua) ? 'mac' : 'other'
}

type Modifier = 'mod' | 'ctrl' | 'alt' | 'shift' | 'meta'

const MODIFIERS: Record<string, Modifier> = {
  mod: 'mod',
  cmd: 'meta',
  meta: 'meta',
  ctrl: 'ctrl',
  control: 'ctrl',
  alt: 'alt',
  option: 'alt',
  shift: 'shift',
}

interface ParsedShortcut {
  modifiers: Set<Modifier>
  key: string
}

function parse(spec: ShortcutSpec): ParsedShortcut {
  const sep = spec.includes('+') && !spec.endsWith('+') ? '+' : '-'
  let parts = spec.split(sep)
  // A trailing separator is the key itself ("Mod--" -> ["Mod", "", ""]).
  if (spec.endsWith(sep) && spec.length > 1) parts = [...parts.slice(0, -2), sep]
  const key = parts.pop() ?? ''
  const modifiers = new Set<Modifier>()
  for (const p of parts) {
    const m = MODIFIERS[p.toLowerCase()]
    if (!m) throw new Error(`Unknown modifier "${p}" in shortcut "${spec}"`)
    modifiers.add(m)
  }
  return { modifiers, key }
}

function resolveMods(mods: Set<Modifier>, platform: Platform): Set<'ctrl' | 'alt' | 'shift' | 'meta'> {
  const out = new Set<'ctrl' | 'alt' | 'shift' | 'meta'>()
  for (const m of mods) out.add(m === 'mod' ? (platform === 'mac' ? 'meta' : 'ctrl') : m)
  return out
}

const KEY_NAMES: Record<string, { mac: string; other: string; aria: string }> = {
  escape: { mac: 'Esc', other: 'Esc', aria: 'Escape' },
  esc: { mac: 'Esc', other: 'Esc', aria: 'Escape' },
  enter: { mac: 'Return', other: 'Enter', aria: 'Enter' },
  arrowup: { mac: '↑', other: 'Up', aria: 'ArrowUp' },
  arrowdown: { mac: '↓', other: 'Down', aria: 'ArrowDown' },
  arrowleft: { mac: '←', other: 'Left', aria: 'ArrowLeft' },
  arrowright: { mac: '→', other: 'Right', aria: 'ArrowRight' },
  space: { mac: 'Space', other: 'Space', aria: 'Space' },
  tab: { mac: 'Tab', other: 'Tab', aria: 'Tab' },
  backspace: { mac: 'Delete', other: 'Backspace', aria: 'Backspace' },
}

function keyLabel(key: string, platform: Platform): string {
  const named = KEY_NAMES[key.toLowerCase()]
  if (named) return named[platform]
  return key.length === 1 ? key.toUpperCase() : key
}

const MAC_SYMBOLS = { ctrl: '⌃', alt: '⌥', shift: '⇧', meta: '⌘' } as const
const MAC_ORDER = ['ctrl', 'alt', 'shift', 'meta'] as const
const OTHER_NAMES = { ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', meta: 'Win' } as const
const OTHER_ORDER = ['ctrl', 'meta', 'alt', 'shift'] as const

/** Human-readable shortcut: "⌘⇧Z" on macOS, "Ctrl+Shift+Z" elsewhere. */
export function formatShortcut(spec: ShortcutSpec, platform: Platform = detectPlatform()): string {
  const { modifiers, key } = parse(spec)
  const mods = resolveMods(modifiers, platform)
  if (platform === 'mac') {
    return MAC_ORDER.filter((m) => mods.has(m)).map((m) => MAC_SYMBOLS[m]).join('') + keyLabel(key, platform)
  }
  return [...OTHER_ORDER.filter((m) => mods.has(m)).map((m) => OTHER_NAMES[m]), keyLabel(key, platform)].join('+')
}

const ARIA_NAMES = { ctrl: 'Control', alt: 'Alt', shift: 'Shift', meta: 'Meta' } as const

/** One `aria-keyshortcuts` token: "Meta+Shift+Z" on macOS, "Control+Shift+Z" elsewhere. */
export function ariaKeyshortcut(spec: ShortcutSpec, platform: Platform = detectPlatform()): string {
  const { modifiers, key } = parse(spec)
  const mods = resolveMods(modifiers, platform)
  const named = KEY_NAMES[key.toLowerCase()]
  const k = named ? named.aria : key.length === 1 ? key.toUpperCase() : key
  return [...OTHER_ORDER.filter((m) => mods.has(m)).map((m) => ARIA_NAMES[m]), k].join('+')
}

/** Normalizes one-or-many specs to an array. */
export function shortcutList(spec: ShortcutSpec | readonly ShortcutSpec[] | undefined): readonly ShortcutSpec[] {
  if (!spec) return []
  return typeof spec === 'string' ? [spec] : spec
}
