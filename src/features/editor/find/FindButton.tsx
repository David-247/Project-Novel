import type { IconButtonProps } from '@/shared/ui'
import { useStore } from '@/shared/store'
import { IconButton } from '@/shared/ui'
import { openFind } from './engine'
import { FIND_PANEL_ID } from './FindReplacePanel'
import { SearchIcon } from './icons'
import { modShortcut } from './use-editor-instance'

export type FindButtonProps = Partial<Omit<IconButtonProps, 'label' | 'children'>>

/**
 * Toolbar button that opens (or re-focuses) the find & replace panel. Same as Mod-f.
 * Extra props and `ref` are forwarded to the button, so it can be wrapped in `ToolbarItem`.
 */
export function FindButton({ onClick, ...rest }: FindButtonProps) {
  const open = useStore((s) => s.find.open)
  return (
    <IconButton
      {...rest}
      label="Find and replace"
      data-control-id="find.open"
      aria-keyshortcuts={modShortcut('F')}
      aria-expanded={open}
      aria-controls={open ? FIND_PANEL_ID : undefined}
      onClick={(e) => {
        onClick?.(e)
        if (!e.defaultPrevented) openFind()
      }}
    >
      <SearchIcon />
    </IconButton>
  )
}
