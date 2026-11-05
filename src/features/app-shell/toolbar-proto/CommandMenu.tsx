import * as DM from '@radix-ui/react-dropdown-menu'
import { useMemo, useRef } from 'react'
import type { ReactNode } from 'react'
import {
  buildMenuModel,
  isCommandEnabled,
  submenuControlId,
  useCommands,
  useCommandStateVersion,
  type Command,
  type MenuNode,
} from '@/shared/commands'
import { cn, detectPlatform, focusRing, formatShortcut } from '@/shared/ui'
import type { ProtoEntry } from './groups'

/** T6 step 1 prototype: a dropdown whose items come from the command registry. */

export interface MenuSection {
  title: string
  entries: ProtoEntry[]
  missing?: string[]
}

const contentClass = cn(
  'z-40 min-w-64 max-w-[calc(100vw-1rem)] max-h-[calc(100dvh-6rem)] overflow-y-auto rounded-control border border-border',
  'bg-surface-raised p-1 text-text shadow-raised',
)
const itemClass = cn(
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

function Check() {
  return (
    <DM.ItemIndicator className="absolute left-2 inline-flex items-center">
      <svg aria-hidden="true" viewBox="0 0 16 16" className="size-4">
        <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </DM.ItemIndicator>
  )
}

const focusManuscript = () => document.querySelector<HTMLElement>('main [contenteditable="true"]')?.focus()

export function CommandMenu({
  trigger,
  sections,
  controlId,
  label,
  align = 'start',
}: {
  trigger: ReactNode
  sections: MenuSection[]
  controlId: string
  label: string
  align?: 'start' | 'end'
}) {
  const commands = useCommands()
  useCommandStateVersion()
  const byId = useMemo(() => new Map(commands.map((c) => [c.id, c])), [commands])
  const model = useMemo(() => buildMenuModel(commands, 'in-app'), [commands])
  const pending = useRef<Command | null>(null)
  const platform = detectPlatform()

  const findSub = (menu: string, subLabel: string): Extract<MenuNode, { kind: 'submenu' }> | null => {
    const want = submenuControlId(menu as never, subLabel)
    const walk = (nodes: MenuNode[]): Extract<MenuNode, { kind: 'submenu' }> | null => {
      for (const n of nodes) {
        if (n.kind === 'submenu') {
          if (n.id === want) return n
          const r = walk(n.children)
          if (r) return r
        }
      }
      return null
    }
    for (const m of model) {
      const r = walk(m.children)
      if (r) return r
    }
    return null
  }

  const item = (c: Command) => {
    const shortcut = c.shortcut ? <span className="ml-auto pl-4 text-ui-xs text-text-muted">{formatShortcut(c.shortcut, platform)}</span> : null
    const props = {
      key: c.id,
      'data-control-id': c.id,
      disabled: !isCommandEnabled(c),
      className: itemClass,
      onSelect: () => {
        pending.current = c
      },
    }
    if (c.isChecked) {
      return (
        <DM.CheckboxItem {...props} checked={safe(c.isChecked)}>
          <Check />
          <span className="truncate">{c.label}</span>
          {shortcut}
        </DM.CheckboxItem>
      )
    }
    return (
      <DM.Item {...props}>
        <span className="truncate">{c.label}</span>
        {shortcut}
      </DM.Item>
    )
  }

  const nodes = (list: MenuNode[]): ReactNode[] =>
    list.map((n, i) => {
      if (n.kind === 'separator') return <DM.Separator key={`s${i}`} className="my-1 h-px bg-border" />
      if (n.kind === 'predefined') return null
      if (n.kind === 'item') return item(n.command)
      return sub(n, `${n.id}`)
    })

  const sub = (n: Extract<MenuNode, { kind: 'submenu' }>, key: string) => (
    <DM.Sub key={key}>
      <DM.SubTrigger className={itemClass} data-control-id={n.id}>
        <span className="truncate">{n.label}</span>
        <svg aria-hidden="true" viewBox="0 0 16 16" className="ml-auto size-4 text-text-muted">
          <path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </DM.SubTrigger>
      <DM.Portal>
        <DM.SubContent className={contentClass} sideOffset={2} collisionPadding={8}>
          {nodes(n.children)}
        </DM.SubContent>
      </DM.Portal>
    </DM.Sub>
  )

  return (
    <DM.Root modal={false}>
      <DM.Trigger asChild>
        <button
          type="button"
          aria-label={label}
          title={label}
          data-control-id={controlId}
          className={cn(
            'inline-flex h-control min-w-control shrink-0 items-center justify-center gap-1 rounded-control px-2 text-ui-sm text-text',
            'hover:bg-surface-hover data-[state=open]:bg-accent-soft data-[state=open]:text-accent',
            focusRing,
          )}
        >
          {trigger}
        </button>
      </DM.Trigger>
      <DM.Portal>
        <DM.Content
          className={contentClass}
          align={align}
          sideOffset={4}
          collisionPadding={8}
          onCloseAutoFocus={(e) => {
            const c = pending.current
            pending.current = null
            if (!c) return
            e.preventDefault()
            focusManuscript()
            if (isCommandEnabled(c)) c.run()
          }}
        >
          {sections.map((s, si) => (
            <DM.Group key={s.title}>
              {si > 0 ? <DM.Separator className="my-1 h-px bg-border" /> : null}
              {sections.length > 1 ? <DM.Label className="px-2.5 pb-0.5 pt-1.5 text-ui-xs font-semibold text-text-muted">{s.title}</DM.Label> : null}
              {s.entries.map((e) => {
                if ('cmd' in e) {
                  const c = byId.get(e.cmd)
                  return c ? item(c) : null
                }
                const n = findSub(e.submenu.menu, e.submenu.label)
                return n ? sub(n, `${s.title}:${n.id}`) : null
              })}
              {s.missing?.length ? (
                <div className="px-2.5 py-1 text-ui-xs italic text-text-muted">Not in the registry yet: {s.missing.join(', ')}</div>
              ) : null}
            </DM.Group>
          ))}
        </DM.Content>
      </DM.Portal>
    </DM.Root>
  )
}

export function Chevron() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" className="size-3.5 text-text-muted">
      <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
