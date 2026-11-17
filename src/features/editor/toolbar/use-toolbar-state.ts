import type { Editor } from '@tiptap/core'
import { useCallback, useSyncExternalStore } from 'react'
import { subscribeDocLoad } from '../controller'
import { IDLE_TOOLBAR_STATE, readToolbarState } from './toolbar-state'
import type { ToolbarState } from './toolbar-state'

function shallowEqual(a: ToolbarState, b: ToolbarState): boolean {
  for (const k of Object.keys(a) as Array<keyof ToolbarState>) if (a[k] !== b[k]) return false
  return true
}

/**
 * One shared reading per editor: the ribbon's groups (Font, Paragraph, Styles…) and the font picker
 * all read the toolbar state, but it is computed once per transaction, not once per reader (typing
 * latency budget). Readers re-render only when a derived value changed.
 */
interface Shared {
  state: ToolbarState
  fresh: boolean
  listeners: Set<() => void>
  detach: (() => void) | null
}

const shared = new WeakMap<Editor, Shared>()

function entry(editor: Editor): Shared {
  let e = shared.get(editor)
  if (!e) {
    e = { state: IDLE_TOOLBAR_STATE, fresh: false, listeners: new Set(), detach: null }
    shared.set(editor, e)
  }
  return e
}

function read(editor: Editor, e: Shared): ToolbarState {
  if (!e.fresh) {
    const next = readToolbarState(editor)
    if (!shallowEqual(next, e.state)) e.state = next
    // Cached only while transactions are watched (otherwise the next read must look again).
    e.fresh = e.detach !== null
  }
  return e.state
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
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!editor) return () => {}
      const e = entry(editor)
      e.listeners.add(onChange)
      if (!e.detach) {
        const changed = () => {
          e.fresh = false
          const before = e.state
          if (read(editor, e) !== before) e.listeners.forEach((l) => l())
        }
        editor.on('transaction', changed)
        const offLoad = subscribeDocLoad(changed)
        e.detach = () => {
          editor.off('transaction', changed)
          offLoad()
        }
      }
      return () => {
        e.listeners.delete(onChange)
        if (e.listeners.size === 0) {
          e.detach?.()
          e.detach = null
          e.fresh = false
        }
      }
    },
    [editor],
  )

  const getSnapshot = () => (editor ? read(editor, entry(editor)) : IDLE_TOOLBAR_STATE)

  return useSyncExternalStore(subscribe, getSnapshot, () => IDLE_TOOLBAR_STATE)
}
