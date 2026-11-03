import { useStore } from '@/shared/store'
import { IconButton } from '@/shared/ui'
import { openFind } from './engine'
import { FIND_PANEL_ID } from './FindReplacePanel'
import { SearchIcon } from './icons'
import { modShortcut } from './use-editor-instance'

/** Toolbar button that opens (or re-focuses) the find & replace panel. Same as Mod-f. */
export function FindButton() {
  const open = useStore((s) => s.find.open)
  return (
    <IconButton
      label="Find and replace"
      data-control-id="find.open"
      aria-keyshortcuts={modShortcut('F')}
      aria-expanded={open}
      aria-controls={open ? FIND_PANEL_ID : undefined}
      onClick={openFind}
    >
      <SearchIcon />
    </IconButton>
  )
}
