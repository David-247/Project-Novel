import type { IconButtonProps } from '@/shared/ui'
import { useStore } from '@/shared/store'
import { ariaKeyshortcuts, IconButton, Tooltip } from '@/shared/ui'
import { FIND_CONTROLS } from './controls'
import { openFind } from './engine'
import { FIND_PANEL_ID } from './FindReplacePanel'
import { SearchIcon } from './icons'

export type FindButtonProps = Partial<Omit<IconButtonProps, 'label' | 'children'>>

/**
 * Toolbar button that opens (or re-focuses) the find & replace panel. Same as Mod-f.
 * Extra props and `ref` are forwarded to the button, so it can be wrapped in `ToolbarItem`.
 */
export function FindButton({ onClick, ...rest }: FindButtonProps) {
  const open = useStore((s) => s.find.open)
  return (
    <Tooltip {...rest}>
      <IconButton
        label={FIND_CONTROLS.open.label}
        data-control-id={FIND_CONTROLS.open.id}
        aria-keyshortcuts={ariaKeyshortcuts(FIND_CONTROLS.open.shortcut)}
        aria-expanded={open}
        aria-controls={open ? FIND_PANEL_ID : undefined}
        onClick={(e) => {
          onClick?.(e)
          if (!e.defaultPrevented) openFind()
        }}
      >
        <SearchIcon />
      </IconButton>
    </Tooltip>
  )
}
