import { useSyncExternalStore } from 'react'
import type { MouseEvent } from 'react'
import { useStore } from '@/shared/store'
import { ariaKeyshortcuts, IconButton, ToggleButton, Tooltip, type IconButtonProps } from '@/shared/ui'
import { isCommentsNarrow, newComment, subscribeCommentsNarrow, toggleCommentsPanel } from './commands'
import { COMMENT_CONTROLS } from './controls'
import { CommentsPanelIcon, NewCommentIcon } from './icons'

export type CommentButtonProps = Partial<Omit<IconButtonProps, 'label' | 'children'>>

/**
 * Toolbar: New Comment (`comment.new`, Mod-Alt-m). Opens the composer for the selection (or the
 * word at the caret). Extra props and `ref` are forwarded, so it can sit in the editor's ToolbarItem.
 */
export function NewCommentButton({ onClick, ...rest }: CommentButtonProps) {
  const meta = COMMENT_CONTROLS.new
  return (
    <Tooltip {...rest}>
      <IconButton
        label={meta.label}
        data-control-id={meta.id}
        aria-keyshortcuts={ariaKeyshortcuts(meta.shortcut)}
        // The selection stays in the manuscript until the composer takes the focus.
        onMouseDown={(e: MouseEvent) => {
          if (e.button === 0) e.preventDefault()
        }}
        onClick={(e) => {
          onClick?.(e)
          if (!e.defaultPrevented) newComment()
        }}
      >
        <NewCommentIcon />
      </IconButton>
    </Tooltip>
  )
}

/** Toolbar: Comments Panel toggle (`comment.panel`): the margin panel, or the drawer when narrow. */
export function CommentsPanelButton({ onClick, ...rest }: CommentButtonProps) {
  const meta = COMMENT_CONTROLS.panel
  const narrow = useSyncExternalStore(subscribeCommentsNarrow, isCommentsNarrow, () => false)
  const pressed = useStore((s) => (narrow ? s.comments.drawerOpen : s.comments.panelOpen))
  return (
    <Tooltip {...rest}>
      <ToggleButton
        label={meta.label}
        data-control-id={meta.id}
        pressed={pressed}
        onMouseDown={(e: MouseEvent) => {
          if (e.button === 0) e.preventDefault()
        }}
        onPressedChange={() => toggleCommentsPanel()}
        onClick={onClick}
      >
        <CommentsPanelIcon />
      </ToggleButton>
    </Tooltip>
  )
}
