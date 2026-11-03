import type { Editor } from '@tiptap/core'
import { useSyncExternalStore } from 'react'
import { getEditor, subscribeEditor } from './controller'

/** The currently mounted editor, or null (re-renders when it mounts/unmounts, not per transaction). */
export function useMountedEditor(): Editor | null {
  return useSyncExternalStore(subscribeEditor, getEditor, () => null)
}
