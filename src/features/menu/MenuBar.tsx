import * as Menubar from '@radix-ui/react-menubar'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
import {
  buildMenuModel,
  isCommandEnabled,
  menuControlId,
  useCommands,
  useCommandStateVersion,
  type Command,
  type MenuId,
  type MenuModel,
  type MenuNode,
} from '@/shared/commands'
import { cn, detectPlatform, focusRing, formatShortcut, Tooltip } from '@/shared/ui'
import { restoreFocus, syncEditorSelection, trackFocusOutsideMenus } from './focus'

const contentClass = cn(
  'z-40 min-w-60 max-w-[calc(100vw-1rem)] max-h-[calc(100dvh-4rem)] overflow-y-auto rounded-control border border-border',
  'bg-surface-raised p-1 text-text shadow-raised',
)
const itemClass = cn(
  'relative flex min-h-control-lg cursor-default select-none items-center gap-3 rounded-control py-1.5 pl-7 pr-2.5',
  'text-ui-sm outline-none data-[highlighted]:bg-surface-hover data-[disabled]:text-text-muted',
  focusRing,
)

function Check() {
  return (
    <Menubar.ItemIndicator className="absolute left-2 inline-flex items-center">
      <svg aria-hidden="true" viewBox="0 0 16 16" className="size-4">
        <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </Menubar.ItemIndicator>
  )
}

function Chevron() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" className="ml-auto size-4 text-text-muted">
      <path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** "File" with its mnemonic letter underlined while the menu bar has focus (Windows convention). */
function MnemonicLabel({ label, mnemonic }: { label: string; mnemonic: string }) {
  const i = label.toLowerCase().indexOf(mnemonic)
  if (i < 0) return <>{label}</>
  return (
    <>
      {label.slice(0, i)}
      <span className="group-focus-within/menubar:underline group-data-[alt]/menubar:underline">{label[i]}</span>
      {label.slice(i + 1)}
    </>
  )
}

/** A modal dialog (or the native message box stand-in) is open. */
const modalOpen = () => !!document.querySelector('[role="dialog"], [role="alertdialog"]')

const safeChecked = (c: Command) => {
  try {
    return c.isChecked!()
  } catch {
    return false
  }
}

/**
 * The in-app menu bar (Windows, web): File, Edit, View, Insert, Format, Review, Help rendered from the
 * command registry, above the toolbar. Radix Menubar keyboard model: arrows move between menus and
 * items, Enter/Space choose, typeahead jumps. Alt (or F10) moves focus to File; Alt+<letter> opens a
 * menu (not on macOS, where Option types characters). Escape, or a chosen command, gives focus back to
 * where it was (normally the manuscript, with its selection), and the command then runs there.
 */
export function MenuBar() {
  const commands = useCommands()
  // Re-render with fresh enabled/checked state while a menu is open.
  useCommandStateVersion()
  const models = useMemo(() => buildMenuModel(commands, 'in-app'), [commands])
  const [value, setValue] = useState('')
  const valueRef = useRef('')
  const pending = useRef<Command | null>(null)
  const outside = useRef(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const [altHint, setAltHint] = useState(false)
  const platform = detectPlatform()

  const changeValue = (v: string) => {
    if (v) outside.current = false
    valueRef.current = v
    setValue(v)
  }

  useEffect(() => trackFocusOutsideMenus(), [])

  const trigger = (id: MenuId) => {
    // Leaving the manuscript: it must hold the latest selection, which is given back afterwards.
    syncEditorSelection()
    return rootRef.current?.querySelector<HTMLElement>(`[data-control-id="${menuControlId(id)}"]`)
  }
  const inBar = () => !!document.activeElement?.closest('[data-nv-menubar], [data-nv-menu-content]')

  // Alt alone and F10 focus the menu bar; Alt+<mnemonic> opens a menu (not on macOS).
  useEffect(() => {
    let altAlone = false
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Alt') {
        altAlone = !e.ctrlKey && !e.metaKey && !e.shiftKey
        return
      }
      altAlone = false
      // A modal dialog owns the keyboard: the menu bar behind it stays out of reach.
      if (e.defaultPrevented || modalOpen()) return
      if (e.key === 'F10' && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        e.preventDefault()
        if (inBar()) {
          changeValue('')
          restoreFocus()
        } else if (models[0]) trigger(models[0].id)?.focus()
        return
      }
      if (platform !== 'mac' && e.altKey && !e.ctrlKey && !e.metaKey && e.key.length === 1) {
        const m = models.find((x) => x.mnemonic === e.key.toLowerCase())
        if (!m) return
        e.preventDefault()
        trigger(m.id)?.focus()
        changeValue(m.id)
      }
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key !== 'Alt' || !altAlone) return
      altAlone = false
      if (modalOpen()) return
      e.preventDefault()
      if (inBar()) {
        changeValue('')
        restoreFocus()
      } else if (models[0]) {
        setAltHint(true)
        trigger(models[0].id)?.focus()
      }
    }
    const reset = () => {
      altAlone = false
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('pointerdown', reset, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('pointerdown', reset, true)
    }
  }, [models, platform])

  /** A menu closed (chosen item, Escape, click elsewhere): focus back, then run the chosen command. */
  const onCloseAutoFocus = (e: Event) => {
    // Moving to the next menu also closes this one: Radix keeps focus in the bar then.
    if (valueRef.current) return
    e.preventDefault()
    const cmd = pending.current
    pending.current = null
    if (outside.current) {
      // A click elsewhere: that click places the focus.
      outside.current = false
      return
    }
    restoreFocus()
    if (cmd && isCommandEnabled(cmd)) cmd.run()
  }

  const select = (cmd: Command) => {
    pending.current = cmd
    // Safety net if the menu closes without an autofocus event (it always sends one in browsers).
    setTimeout(() => {
      if (pending.current !== cmd) return
      pending.current = null
      restoreFocus()
      if (isCommandEnabled(cmd)) cmd.run()
    }, 250)
  }

  const onRootKeyDown = (e: ReactKeyboardEvent) => {
    // Escape on a closed menu's title: back to the manuscript. (Escape inside an open menu closes it;
    // the close then gives focus back.)
    const inMenu = e.target instanceof Element && e.target.closest('[data-nv-menu-content]')
    if (e.key === 'Escape' && !valueRef.current && !inMenu) {
      e.preventDefault()
      restoreFocus()
    }
  }

  const contentProps = {
    'data-nv-menu-content': '',
    className: contentClass,
    onCloseAutoFocus,
    onPointerDownOutside: (e: Event) => {
      // Not a press on another menu title (that only switches menus).
      if (!(e.target instanceof Element && e.target.closest('[data-nv-menubar]'))) outside.current = true
    },
    collisionPadding: 8,
  }

  const renderNodes = (nodes: MenuNode[]): ReactNode =>
    nodes.map((n, i) => {
      if (n.kind === 'separator') return <Menubar.Separator key={`sep-${i}`} className="my-1 h-px bg-border" />
      if (n.kind === 'predefined') return null
      if (n.kind === 'submenu') {
        return (
          <Menubar.Sub key={n.id}>
            <Tooltip side="right" controlId={n.id}>
              <Menubar.SubTrigger data-control-id={n.id} className={cn(itemClass, 'data-[state=open]:bg-surface-hover')}>
                <span className="flex-1">{n.label}</span>
                <Chevron />
              </Menubar.SubTrigger>
            </Tooltip>
            <Menubar.Portal>
              <Menubar.SubContent {...contentProps} sideOffset={2} alignOffset={-4}>
                {renderNodes(n.children)}
              </Menubar.SubContent>
            </Menubar.Portal>
          </Menubar.Sub>
        )
      }
      const c = n.command
      const disabled = !isCommandEnabled(c)
      const body = (
        <>
          {c.isChecked ? <Check /> : null}
          <span data-part="label" className="flex-1">{c.label}</span>
          {c.shortcut ? <span data-part="shortcut" className="text-ui-xs text-text-muted">{formatShortcut(c.shortcut, platform)}</span> : null}
        </>
      )
      return (
        <Tooltip key={c.id} side="right" controlId={c.id}>
          {c.isChecked ? (
            <Menubar.CheckboxItem
              data-control-id={c.id}
              className={itemClass}
              checked={safeChecked(c)}
              disabled={disabled}
              onSelect={() => select(c)}
            >
              {body}
            </Menubar.CheckboxItem>
          ) : (
            <Menubar.Item data-control-id={c.id} className={itemClass} disabled={disabled} onSelect={() => select(c)}>
              {body}
            </Menubar.Item>
          )}
        </Tooltip>
      )
    })

  if (models.length === 0) return null
  return (
    <Menubar.Root
      ref={rootRef}
      value={value}
      onValueChange={changeValue}
      loop
      data-nv-menubar=""
      data-alt={altHint || undefined}
      aria-label="Menu bar"
      onKeyDown={onRootKeyDown}
      onPointerDownCapture={syncEditorSelection}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setAltHint(false)
      }}
      className="group/menubar flex min-h-control items-center gap-0.5 border-b border-border bg-bg px-1 sm:px-2"
    >
      {models.map((m: MenuModel) => (
        <Menubar.Menu key={m.id} value={m.id}>
          <Tooltip controlId={menuControlId(m.id)}>
            <Menubar.Trigger
              data-control-id={menuControlId(m.id)}
              className={cn(
                'inline-flex min-h-control min-w-control select-none items-center justify-center rounded-control px-2.5',
                'text-ui-sm text-text hover:bg-surface-hover data-[state=open]:bg-surface-hover data-[highlighted]:bg-surface-hover',
                focusRing,
              )}
            >
              <MnemonicLabel label={m.label} mnemonic={m.mnemonic} />
            </Menubar.Trigger>
          </Tooltip>
          <Menubar.Portal>
            <Menubar.Content {...contentProps} align="start" sideOffset={4}>
              {renderNodes(m.children)}
            </Menubar.Content>
          </Menubar.Portal>
        </Menubar.Menu>
      ))}
    </Menubar.Root>
  )
}
