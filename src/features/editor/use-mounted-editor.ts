import type { Editor } from '@tiptap/core'
import { useSyncExternalStore } from 'react'
import { getActiveEditor, getEditor, onActiveEditorChange, subscribeEditor } from './controller'

/** The currently mounted editor, or null (re-renders when it mounts/unmounts, not per transaction). */
export function useMountedEditor(): Editor | null {
  return useSyncExternalStore(subscribeEditor, getEditor, () => null)
}

const subscribeActive = (cb: () => void) => {
  const offEditor = subscribeEditor(cb)
  const offActive = onActiveEditorChange(cb)
  return () => {
    offActive()
    offEditor()
  }
}

/**
 * The editor text controls act on (`getActiveEditor()`): the manuscript, or the re-write's revision
 * while the re-write view is open (null while the focus is elsewhere in that view). The formatting
 * controls of the ribbon use it, so they follow the same target as the menus and shortcuts.
 */
export function useActiveEditor(): Editor | null {
  return useSyncExternalStore(subscribeActive, getActiveEditor, () => null)
}
