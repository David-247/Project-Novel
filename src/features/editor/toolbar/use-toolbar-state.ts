import type { Editor } from '@tiptap/core'
import { useCallback, useRef, useSyncExternalStore } from 'react'
import { subscribeDocLoad } from '../controller'
import { IDLE_TOOLBAR_STATE, readToolbarState } from './toolbar-state'
import type { ToolbarState } from './toolbar-state'

function shallowEqual(a: ToolbarState, b: ToolbarState): boolean {
  for (const k of Object.keys(a) as Array<keyof ToolbarState>) if (a[k] !== b[k]) return false
  return true
}

/**
 * Toolbar state for `editor`, re-rendering only when a derived value changes. Recomputed
 * (O(selection), see `readToolbarState`) on every editor transaction (edits and selection
 * changes) and on whole-document loads (`setDocJSON` / mount restore swap EditorState without a
 * transaction; the controller's `subscribeDocLoad` reports them). It reads the closure `editor`,
 * never a stale snapshot. Unlike `useEditorState`, it is correct immediately after the
 * editor mounts.
 */
export function useToolbarState(editor: Editor | null): ToolbarState {
  const cache = useRef<ToolbarState>(IDLE_TOOLBAR_STATE)

  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!editor) return () => {}
      editor.on('transaction', onChange)
      const offLoad = subscribeDocLoad(onChange)
      return () => {
        editor.off('transaction', onChange)
        offLoad()
      }
    },
    [editor],
  )

  const getSnapshot = () => {
    const next = readToolbarState(editor)
    if (shallowEqual(next, cache.current)) return cache.current
    cache.current = next
    return next
  }

  return useSyncExternalStore(subscribe, getSnapshot, () => IDLE_TOOLBAR_STATE)
}
