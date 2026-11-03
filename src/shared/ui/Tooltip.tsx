import * as RTooltip from '@radix-ui/react-tooltip'
import { cloneElement, createContext, isValidElement, useContext, useEffect, useId, useMemo, useState } from 'react'
import type { FocusEvent, KeyboardEvent, MouseEvent, PointerEvent, ReactElement, ReactNode, Ref } from 'react'
import { flushSync } from 'react-dom'
import { ariaKeyshortcut, detectPlatform, formatShortcut, shortcutList } from './shortcut'
import type { Platform, ShortcutSpec } from './shortcut'
import { cn } from './styles'

/** What a tooltip says. Copy for app controls lives in the tooltips slice's registry. */
export interface TooltipCopy {
  /** Short name of the control (usually the same as its accessible name). */
  title: string
  /** One line saying what the control does. */
  description?: string
  /** Shortcut spec(s), e.g. "Mod-b" or ["Mod-Shift-z", "Mod-y"]; rendered per platform. */
  shortcut?: ShortcutSpec | readonly ShortcutSpec[]
}

/** Resolves a control id (`data-control-id`) to its tooltip copy. */
export type TooltipLookup = (controlId: string) => TooltipCopy | undefined

interface TooltipEnv {
  lookup: TooltipLookup
  /** False outside any provider with a lookup (e.g. a slice's own unit tests): no warnings then. */
  hasLookup: boolean
  platform: Platform
}

const TooltipEnvContext = createContext<TooltipEnv>({ lookup: () => undefined, hasLookup: false, platform: detectPlatform() })

export interface TooltipProviderProps {
  /** Copy source for `<Tooltip>`s that name a control id instead of passing `copy`. */
  lookup?: TooltipLookup
  /** Hover delay before the first tooltip opens (ms). Keyboard focus opens immediately. */
  delayDuration?: number
  /** After one tooltip closes, others open instantly for this long (ms). */
  skipDelayDuration?: number
  /** Override platform detection (tests, storybook-like previews). */
  platform?: Platform
  children: ReactNode
}

/** Mount once near the root. Supplies hover timing and the copy lookup to every `Tooltip`. */
export function TooltipProvider({
  lookup,
  delayDuration = 500,
  skipDelayDuration = 300,
  platform,
  children,
}: TooltipProviderProps) {
  const parent = useContext(TooltipEnvContext)
  useEffect(installTabListener, [])
  const env = useMemo<TooltipEnv>(
    () => ({
      lookup: lookup ?? parent.lookup,
      hasLookup: Boolean(lookup) || parent.hasLookup,
      platform: platform ?? parent.platform,
    }),
    [lookup, platform, parent],
  )
  return (
    <TooltipEnvContext.Provider value={env}>
      <RTooltip.Provider delayDuration={delayDuration} skipDelayDuration={skipDelayDuration}>
        {children}
      </RTooltip.Provider>
    </TooltipEnvContext.Provider>
  )
}

/** The text a screen reader hears as the control's description (title is already its name). */
export function describeTooltip(copy: TooltipCopy, platform: Platform): string {
  const keys = shortcutList(copy.shortcut).map((s) => formatShortcut(s, platform))
  const parts = [copy.description ?? copy.title]
  if (keys.length) parts.push(`Shortcut: ${keys.join(' or ')}.`)
  return parts.join(' ')
}

function isTextField(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false
  if (el.tagName === 'TEXTAREA' || el.isContentEditable) return true
  return el.tagName === 'INPUT' && !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color'].includes((el as HTMLInputElement).type)
}

// Last time Tab was pressed anywhere (one listener for the whole app, installed lazily).
let lastTabAt = -Infinity
let tabListenerInstalled = false
function installTabListener() {
  if (tabListenerInstalled || typeof window === 'undefined') return
  tabListenerInstalled = true
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Tab') lastTabAt = performance.now()
    },
    true,
  )
}
/** Radix Tooltip closes every open tooltip when this document event fires (its internal TOOLTIP_OPEN). */
const RADIX_TOOLTIP_OPEN_EVENT = 'tooltip.open'

// Number of tooltips open right now (normally 0 or 1).
let openTooltips = 0

function tabbedRecently(): boolean {
  return performance.now() - lastTabAt < 1000
}

/** Keys that leave the tooltip up: focus movement, modifiers, and Escape (handled separately). */
const KEEP_OPEN_KEYS = new Set(['Tab', 'Shift', 'Control', 'Alt', 'Meta', 'Escape', 'CapsLock'])

type TriggerChildProps = Record<string, unknown> & { 'data-control-id'?: string; 'aria-keyshortcuts'?: string }

export interface TooltipProps {
  /** Exactly one focusable control (must spread props and `ref` onto its element). */
  children: ReactElement
  /** Registry key; defaults to the child's `data-control-id`. */
  controlId?: string
  /** Explicit copy (wins over the lookup). */
  copy?: TooltipCopy
  side?: 'top' | 'right' | 'bottom' | 'left'
  /**
   * Hover/anchor a wrapping inline element instead of the control itself, for controls whose
   * visible area is larger than the focusable element (a checkbox with its label). Focus and the
   * description still belong to the control.
   */
  wrap?: boolean
  ref?: Ref<HTMLElement>
  // Props from an asChild parent (e.g. a toolbar item) are forwarded to the trigger.
  [prop: string]: unknown
}

/**
 * Hover + keyboard-focus tooltip over Radix Tooltip, showing title, one-line description and a
 * platform-rendered shortcut hint.
 *
 * - Opens on hover (after the provider delay) and on keyboard focus (not on pointer focus).
 * - The description is also linked permanently via `aria-describedby` to a hidden element, so
 *   screen readers get it without hovering (touch has no hover). Long-press / right-click on
 *   non-text controls shows the tooltip too.
 * - Escape closes it without consuming the key: the toolbar's Escape-to-editor and the find
 *   panel's Escape-to-close still run on the same key press.
 * - Typing into the control (any key but Tab/modifiers) hides it, so it never covers input.
 * - Forwards unknown props and `ref` to the trigger, so it can sit inside `ToolbarItem`.
 */
export function Tooltip({ children, controlId, copy, side = 'bottom', wrap = false, ...forwarded }: TooltipProps) {
  // `forwarded` includes `ref` (React 19 ref-as-prop) and flows to the trigger element.
  const env = useContext(TooltipEnvContext)
  const [open, setOpen] = useState(false)
  const descId = useId()
  const childProps = (isValidElement(children) ? children.props : {}) as TriggerChildProps
  const id = controlId ?? childProps['data-control-id']
  const resolved = copy ?? (id ? env.lookup(id) : undefined)

  // Close on Escape *before* Radix sees it. Radix's dismissable layer listens on document (capture)
  // and calls preventDefault() on Escape, which would make other Escape handlers think the key was
  // already handled. Window capture runs first; flushSync unmounts the content (and its listener)
  // synchronously, so the event continues to its real handlers untouched.
  useEffect(() => {
    if (!open) return
    openTooltips++
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') flushSync(() => setOpen(false))
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      openTooltips--
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  if (!resolved) {
    if (import.meta.env.DEV && id && env.hasLookup) console.warn(`Tooltip: no copy registered for control "${id}"`)
    return cloneElement(children, forwarded)
  }

  const description = describeTooltip(resolved, env.platform)
  const keys = shortcutList(resolved.shortcut)
  const a11y: Record<string, string | undefined> = {
    // While open, Radix points aria-describedby at the content (same text); avoid reading it twice.
    'aria-describedby': open ? undefined : descId,
  }
  if (keys.length && !childProps['aria-keyshortcuts']) {
    a11y['aria-keyshortcuts'] = keys.map((k) => ariaKeyshortcut(k, env.platform)).join(' ')
  }

  // Opening outside Radix's own triggers: announce it like Radix does, so any other open tooltip closes.
  const openNow = () => {
    document.dispatchEvent(new CustomEvent(RADIX_TOOLTIP_OPEN_EVENT))
    setOpen(true)
  }
  const fwdKeyDown = forwarded.onKeyDown as ((e: KeyboardEvent) => void) | undefined
  const fwdContextMenu = forwarded.onContextMenu as ((e: MouseEvent) => void) | undefined
  const fwdFocus = forwarded.onFocus as ((e: FocusEvent) => void) | undefined
  const fwdPointerMove = forwarded.onPointerMove as ((e: PointerEvent) => void) | undefined
  const behaviour = {
    onPointerMove: (e: PointerEvent) => {
      fwdPointerMove?.(e)
      // Sliding along a toolbar while a tooltip is up: switch to this control's tooltip at once.
      // (Radix ignores moves inside the previous tooltip's hover "grace area", which for a wide
      // tooltip below a small button covers its neighbours.)
      if (e.pointerType !== 'touch' && !open && openTooltips > 0) openNow()
    },
    onFocus: (e: FocusEvent) => {
      fwdFocus?.(e)
      // Text fields show their tooltip only when reached with Tab, not when focused by a shortcut
      // (Mod-f) or script, so the tooltip never pops over a field the user is about to type in.
      // preventDefault on a focus event only tells Radix not to open; focus is unaffected.
      if (isTextField(e.target) && !tabbedRecently()) e.preventDefault()
    },
    onKeyDown: (e: KeyboardEvent) => {
      fwdKeyDown?.(e)
      if (open && !KEEP_OPEN_KEYS.has(e.key)) setOpen(false)
    },
    onContextMenu: (e: MouseEvent) => {
      fwdContextMenu?.(e)
      // Long-press on touch (and right-click) reveals the tooltip; text fields keep their menu.
      if (e.defaultPrevented || isTextField(e.target)) return
      e.preventDefault()
      openNow()
    },
  }

  const trigger = wrap ? (
    <RTooltip.Trigger asChild>
      <span className="inline-flex" {...behaviour} data-tooltip-anchor="">
        {cloneElement(children, { ...forwarded, ...a11y })}
      </span>
    </RTooltip.Trigger>
  ) : (
    <RTooltip.Trigger asChild {...(forwarded as Record<string, unknown>)} {...a11y} {...behaviour}>
      {children}
    </RTooltip.Trigger>
  )

  return (
    <RTooltip.Root open={open} onOpenChange={setOpen}>
      {trigger}
      <span id={descId} hidden>
        {description}
      </span>
      <RTooltip.Portal>
        <RTooltip.Content
          side={side}
          sideOffset={6}
          collisionPadding={8}
          aria-label={description}
          className={cn(
            'z-50 max-w-72 rounded-control border border-border bg-surface-raised px-2.5 py-1.5',
            'text-ui-xs text-text shadow-raised select-none',
          )}
        >
          <TooltipBody copy={resolved} platform={env.platform} />
        </RTooltip.Content>
      </RTooltip.Portal>
    </RTooltip.Root>
  )
}

function TooltipBody({ copy, platform }: { copy: TooltipCopy; platform: Platform }) {
  const keys = shortcutList(copy.shortcut)
  return (
    <div data-tooltip-body="">
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-semibold">{copy.title}</span>
        {keys.length ? (
          <span className="whitespace-nowrap text-text-muted">
            {keys.map((k, i) => (
              <span key={k}>
                {i > 0 ? ' or ' : null}
                <kbd className="font-sans">{formatShortcut(k, platform)}</kbd>
              </span>
            ))}
          </span>
        ) : null}
      </div>
      {copy.description ? <p className="mt-0.5 text-text-muted">{copy.description}</p> : null}
    </div>
  )
}
