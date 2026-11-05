import * as DM from '@radix-ui/react-dropdown-menu'
import * as RToolbar from '@radix-ui/react-toolbar'
import { useMemo, useRef } from 'react'
import type { ReactNode } from 'react'
import { getEditor } from '@/features/editor'
import {
  buildMenuModel,
  isCommandEnabled,
  submenuControlId,
  useCommands,
  useCommandStateVersion,
  type Command,
  type MenuId,
  type MenuNode,
} from '@/shared/commands'
import type { RibbonMenuEntry } from '@/shared/ribbon'
import { cn, detectPlatform, focusRing, formatShortcut, Tooltip } from '@/shared/ui'

/**
 * A ribbon dropdown whose items come from the command registry: the same labels, shortcuts and
 * enabled/checked state as the menu bar. Used by collapsed groups, the compact Paragraph "Spacing"
 * dropdown and the overflow ("More") menu.
 *
 * Focus: opening reads the manuscript's pending selection first; choosing an item gives the focus back
 * to the manuscript (its selection intact) and then runs the command there, like the menu bar. Escape
 * returns focus to the trigger.
 */

/** One group's entries, under the group's name when the menu holds several (the overflow). */
export interface MenuSection {
  title: string
  entries: RibbonMenuEntry[]
}

const contentClass = cn(
  'z-40 min-w-60 max-w-[calc(100vw-1rem)] max-h-[calc(100dvh-7rem)] overflow-y-auto rounded-control border border-border',
  'bg-surface-raised p-1 text-text shadow-raised',
)
export const menuItemClass = cn(
  'relative flex min-h-control cursor-default select-none items-center gap-3 rounded-control py-1 pl-7 pr-2.5',
  'text-ui-sm outline-none data-[highlighted]:bg-surface-hover data-[disabled]:text-text-muted',
  focusRing,
)

const safe = (f: () => boolean) => {
  try {
    return f()
  } catch {
    return false
  }
}

/** Make the manuscript read a selection change it has not picked up yet, before a menu takes focus. */
export function syncEditorSelection(): void {
  const view = getEditor()?.view as unknown as { domObserver?: { flush(): void }; hasFocus(): boolean } | undefined
  if (view?.hasFocus()) view.domObserver?.flush()
}

function Check() {
  return (
    <DM.ItemIndicator className="absolute left-2 inline-flex items-center">
      <svg aria-hidden="true" viewBox="0 0 16 16" className="size-4">
        <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </DM.ItemIndicator>
  )
}

function SubChevron() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" className="ml-auto size-4 text-text-muted">
      <path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function Chevron() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" className="size-3.5 shrink-0 text-text-muted">
      <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

type SubmenuNode = Extract<MenuNode, { kind: 'submenu' }>

function findSubmenu(model: ReturnType<typeof buildMenuModel>, menu: MenuId, label: string): SubmenuNode | null {
  const want = submenuControlId(menu, label)
  const walk = (nodes: MenuNode[]): SubmenuNode | null => {
    for (const n of nodes) {
      if (n.kind !== 'submenu') continue
      if (n.id === want) return n
      const r = walk(n.children)
      if (r) return r
    }
    return null
  }
  for (const m of model) {
    const r = walk(m.children)
    if (r) return r
  }
  return null
}

export interface RegistryMenuProps {
  controlId: string
  /** Accessible name of the trigger (and its tooltip title comes from the registry by controlId). */
  label: string
  trigger: ReactNode
  sections: MenuSection[]
  align?: 'start' | 'end'
  className?: string
}

/** A toolbar item (Radix roving focus) that opens a registry dropdown. */
export function RegistryMenu({ controlId, label, trigger, sections, align = 'start', className }: RegistryMenuProps) {
  const commands = useCommands()
  useCommandStateVersion()
  const byId = useMemo(() => new Map(commands.map((c) => [c.id, c])), [commands])
  const model = useMemo(() => buildMenuModel(commands, 'in-app'), [commands])
  const pending = useRef<Command | null>(null)
  const platform = detectPlatform()

  const item = (c: Command, key: string) => {
    const shortcut = c.shortcut ? (
      <span className="ml-auto pl-4 text-ui-xs text-text-muted">{[c.shortcut].flat().map((s) => formatShortcut(s, platform)).join(' ')}</span>
    ) : null
    const common = {
      'data-control-id': c.id,
      disabled: !isCommandEnabled(c),
      className: menuItemClass,
      onSelect: () => {
        pending.current = c
      },
    }
    return (
      <Tooltip key={key} side="right" controlId={c.id}>
        {c.isChecked ? (
          <DM.CheckboxItem {...common} checked={safe(c.isChecked)}>
            <Check />
            <span className="truncate">{c.label}</span>
            {shortcut}
          </DM.CheckboxItem>
        ) : (
          <DM.Item {...common}>
            <span className="truncate">{c.label}</span>
            {shortcut}
          </DM.Item>
        )}
      </Tooltip>
    )
  }

  const nodes = (list: MenuNode[], prefix: string): ReactNode[] =>
    list.map((n, i) => {
      if (n.kind === 'separator') return <DM.Separator key={`${prefix}s${i}`} className="my-1 h-px bg-border" />
      if (n.kind === 'predefined') return null
      if (n.kind === 'item') return item(n.command, `${prefix}${n.command.id}`)
      return submenu(n, `${prefix}${n.id}`)
    })

  const submenu = (n: SubmenuNode, key: string) => (
    <DM.Sub key={key}>
      <Tooltip side="right" controlId={n.id}>
        <DM.SubTrigger className={menuItemClass} data-control-id={n.id}>
          <span className="truncate">{n.label}</span>
          <SubChevron />
        </DM.SubTrigger>
      </Tooltip>
      <DM.Portal>
        <DM.SubContent className={contentClass} data-nv-menu-content="" sideOffset={2} collisionPadding={8}>
          {nodes(n.children, `${key}/`)}
        </DM.SubContent>
      </DM.Portal>
    </DM.Sub>
  )

  const entries = (s: MenuSection) =>
    s.entries.map((e) => {
      if ('cmd' in e) {
        const c = byId.get(e.cmd)
        return c ? item(c, `${s.title}:${c.id}`) : null
      }
      const n = findSubmenu(model, e.submenu.menu, e.submenu.label)
      return n ? submenu(n, `${s.title}:${n.id}`) : null
    })

  return (
    <DM.Root modal={false}>
      <RToolbar.Button asChild>
        <Tooltip controlId={controlId}>
          <DM.Trigger asChild>
            <button
              type="button"
              aria-label={label}
              data-control-id={controlId}
              onPointerDown={syncEditorSelection}
              onKeyDown={syncEditorSelection}
              className={cn(
                'inline-flex h-control min-w-control shrink-0 items-center justify-center gap-1.5 rounded-control px-2 text-ui-sm text-text',
                'hover:bg-surface-hover data-[state=open]:bg-accent-soft data-[state=open]:text-accent',
                focusRing,
                className,
              )}
            >
              {trigger}
            </button>
          </DM.Trigger>
        </Tooltip>
      </RToolbar.Button>
      <DM.Portal>
        <DM.Content
          className={contentClass}
          data-nv-menu-content=""
          align={align}
          sideOffset={4}
          collisionPadding={8}
          onCloseAutoFocus={(e) => {
            const c = pending.current
            pending.current = null
            if (!c) return // Escape or a click elsewhere: Radix puts focus back on the trigger.
            e.preventDefault()
            getEditor()?.view.focus()
            if (isCommandEnabled(c)) c.run()
          }}
        >
          {sections.map((s, si) => (
            <DM.Group key={s.title} aria-label={s.title}>
              {si > 0 ? <DM.Separator className="my-1 h-px bg-border" /> : null}
              {sections.length > 1 ? <DM.Label className="px-2.5 pb-0.5 pt-1.5 text-ui-xs font-semibold text-text-muted">{s.title}</DM.Label> : null}
              {entries(s)}
            </DM.Group>
          ))}
        </DM.Content>
      </DM.Portal>
    </DM.Root>
  )
}
