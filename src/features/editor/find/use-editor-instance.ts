import type { Editor } from '@tiptap/core'
import { useSyncExternalStore } from 'react'
import { getEditor, subscribeEditor } from '../controller'

/** The mounted editor (or null); re-renders when it mounts/unmounts. */
export function useEditorInstance(): Editor | null {
  return useSyncExternalStore(subscribeEditor, getEditor, () => null)
}
