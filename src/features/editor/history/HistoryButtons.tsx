import type { Editor } from '@tiptap/core'
import { useCallback, useSyncExternalStore } from 'react'
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
export function HistoryButtons() {
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

  return (
    <>
      <IconButton
        label="Undo"
        data-control-id="history.undo"
        aria-keyshortcuts={modShortcut('Z')}
        disabled={!canUndo}
        onClick={() => editor?.chain().focus().undo().run()}
      >
        <UndoIcon />
      </IconButton>
      <IconButton
        label="Redo"
        data-control-id="history.redo"
        aria-keyshortcuts={`${modShortcut('Z', true)} ${modShortcut('Y')}`}
        disabled={!canRedo}
        onClick={() => editor?.chain().focus().redo().run()}
      >
        <RedoIcon />
      </IconButton>
    </>
  )
}
