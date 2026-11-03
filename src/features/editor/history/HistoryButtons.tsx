import type { Editor } from '@tiptap/core'
import { Fragment, useCallback, useSyncExternalStore } from 'react'
import type { MouseEvent, ReactElement, ReactNode } from 'react'
import { useStore } from '@/shared/store'
import { IconButton } from '@/shared/ui'
import { RedoIcon, UndoIcon } from '../find/icons'
import { modShortcut, useEditorInstance } from '../find/use-editor-instance'

function snapshot(editor: Editor | null): string {
  if (!editor || editor.isDestroyed) return '00'
  const can = editor.can()
  return `${can.undo() ? 1 : 0}${can.redo() ? 1 : 0}`
}

/**
 * Undo / redo toolbar buttons, disabled when there is nothing to undo / redo.
 * Re-renders only when that availability flips (not on every keystroke). Also refreshes on
 * document loads, which replace the editor state without a transaction.
 * Shortcuts: Mod-z undo; Mod-Shift-z or Mod-y redo (bound in the editor keymap).
 */
export interface HistoryButtonsProps {
  /**
   * Wrap each button, e.g. in the toolbar's `ToolbarItem` so it joins roving focus:
   * `wrap={(button, { disabled }) => <ToolbarItem disabled={disabled}>{button}</ToolbarItem>}`.
   */
  wrap?: (button: ReactElement, info: { disabled: boolean; id: 'history.undo' | 'history.redo' }) => ReactNode
}

const identity = (button: ReactElement) => button

export function HistoryButtons({ wrap = identity }: HistoryButtonsProps = {}) {
  const editor = useEditorInstance()
  const subscribe = useCallback(
    (cb: () => void) => {
      editor?.on('transaction', cb)
      const unsubStore = useStore.subscribe((s, p) => {
        if (s.editor.docVersion !== p.editor.docVersion) cb()
      })
      return () => {
        editor?.off('transaction', cb)
        unsubStore()
      }
    },
    [editor],
  )
  const state = useSyncExternalStore(subscribe, () => snapshot(editor), () => '00')
  const canUndo = state[0] === '1'
  const canRedo = state[1] === '1'

  /**
   * Pointer activation returns focus to the text (like the formatting toolbar); keyboard
   * activation keeps focus on the button unless it just became disabled.
   */
  const run = (e: MouseEvent, cmd: 'undo' | 'redo') => {
    if (!editor) return
    if (e.detail > 0) {
      editor.chain().focus()[cmd]().run()
      return
    }
    editor.commands[cmd]()
    if (!editor.can()[cmd]()) editor.commands.focus()
  }

  const undo = (
    <IconButton
      label="Undo"
      data-control-id="history.undo"
      aria-keyshortcuts={modShortcut('Z')}
      disabled={!canUndo}
      onClick={(e) => run(e, 'undo')}
    >
      <UndoIcon />
    </IconButton>
  )
  const redo = (
    <IconButton
      label="Redo"
      data-control-id="history.redo"
      aria-keyshortcuts={`${modShortcut('Z', true)} ${modShortcut('Y')}`}
      disabled={!canRedo}
      onClick={(e) => run(e, 'redo')}
    >
      <RedoIcon />
    </IconButton>
  )
  return (
    <>
      <Fragment key="undo">{wrap(undo, { disabled: !canUndo, id: 'history.undo' })}</Fragment>
      <Fragment key="redo">{wrap(redo, { disabled: !canRedo, id: 'history.redo' })}</Fragment>
    </>
  )
}
