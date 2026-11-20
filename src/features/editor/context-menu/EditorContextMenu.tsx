import * as Menu from '@radix-ui/react-context-menu'
import { useEffect, useRef, useState } from 'react'
import { cn, detectPlatform, focusRing, formatShortcut, Tooltip } from '@/shared/ui'
import { getEditor } from '../controller'
import { pasteFromClipboard } from '../commands'
import { contextMenuSections, registerContextMenuItems, type ContextMenuContext, type MenuItem } from './registry'
import { setContextMenuOpener } from './opener'

const itemClass = cn(
  'relative flex min-h-control-lg cursor-default select-none items-center gap-3 rounded-control px-2.5 py-1.5',
  'text-ui-sm outline-none data-[highlighted]:bg-surface-hover data-[disabled]:opacity-50',
  focusRing,
)

/**
 * Cut, Copy and Paste: the Edit menu's commands (their ids give the tooltip copy). The selection is
 * the manuscript's again first, so the webview's clipboard commands act on it.
 */
function clipboardItems({ editor, selection }: ContextMenuContext): MenuItem[] {
  const refocus = () => editor.view.focus()
  const editable = editor.isEditable
  return [
    { id: 'edit.cut', label: 'Cut', group: 'clipboard', order: 300, shortcut: 'Mod-x', disabled: selection.empty || !editable, run: () => (refocus(), document.execCommand('cut')) },
    { id: 'edit.copy', label: 'Copy', group: 'clipboard', order: 310, shortcut: 'Mod-c', disabled: selection.empty, run: () => (refocus(), document.execCommand('copy')) },
    { id: 'edit.paste', label: 'Paste', group: 'clipboard', order: 320, shortcut: 'Mod-v', disabled: !editable, run: () => (refocus(), void pasteFromClipboard(false)) },
  ]
}

interface Opened {
  sections: MenuItem[][]
  keyboard: boolean
}

/**
 * The manuscript's context menu (Word's): right-click, Shift+F10 or the Menu key. Items come from
 * the registry (registerContextMenuItems): spelling suggestions first, Ignore Once and Add to
 * Dictionary, then the clipboard. Radix ContextMenu, opened at the pointer or the caret through a
 * zero-size trigger; arrows move, Enter chooses, Escape closes and returns to the text. Every item
 * has a tooltip (its `data-control-id`).
 */
export function EditorContextMenu() {
  const [opened, setOpened] = useState<Opened | null>(null)
  const trigger = useRef<HTMLSpanElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const chose = useRef(false)
  const platform = detectPlatform()

  useEffect(() => registerContextMenuItems(clipboardItems), [])
  useEffect(
    () =>
      setContextMenuOpener(({ pos, x, y, keyboard }) => {
        const editor = getEditor()
        const el = trigger.current
        if (!editor || editor.isDestroyed || !el) return false
        const sections = contextMenuSections({ editor, pos, selection: editor.state.selection })
        if (sections.length === 0) return false
        setOpened({ sections, keyboard: !!keyboard })
        // Radix opens a context menu from its trigger's contextmenu event, at the event's point.
        el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y }))
        return true
      }),
    [],
  )
  // From the keyboard the first item takes the focus (Word), so Enter applies it. Runs after the menu's
  // own focus scope has focused the content (child effects first).
  useEffect(() => {
    if (opened?.keyboard) content.current?.querySelector<HTMLElement>('[role="menuitem"]:not([data-disabled])')?.focus()
  }, [opened])

  return (
    <Menu.Root modal={false} onOpenChange={(open) => !open && setTimeout(() => setOpened(null), 0)}>
      <Menu.Trigger asChild>
        <span ref={trigger} aria-hidden="true" data-nv-context-trigger="" style={{ position: 'fixed', left: 0, top: 0, width: 0, height: 0 }} />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content
          ref={content}
          collisionPadding={8}
          aria-label="Manuscript actions"
          onCloseAutoFocus={(e) => {
            // Back to the manuscript with its selection (also after an item changed the text).
            e.preventDefault()
            const ed = getEditor()
            if (ed && !ed.isDestroyed && (chose.current || !document.activeElement || document.activeElement === document.body)) ed.view.focus()
            chose.current = false
          }}
          className="z-50 min-w-56 max-w-[calc(100vw-1rem)] rounded-control border border-border bg-surface-raised p-1 text-text shadow-raised"
        >
          {opened?.sections.map((section, i) => (
            <Menu.Group key={section[0].group + i}>
              {i > 0 && <Menu.Separator className="my-1 h-px bg-border" />}
              {section.map((item) => (
                <Tooltip key={item.id + item.label} side="right" controlId={item.id} copy={item.copy}>
                  <Menu.Item
                    data-control-id={item.id}
                    disabled={item.disabled}
                    className={itemClass}
                    onSelect={() => {
                      chose.current = true
                      item.run()
                    }}
                  >
                    <span className={cn('flex-1', item.emphasis && 'font-semibold')}>{item.label}</span>
                    {item.shortcut && <span className="text-text-muted">{formatShortcut(item.shortcut, platform)}</span>}
                  </Menu.Item>
                </Tooltip>
              ))}
            </Menu.Group>
          ))}
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  )
}
