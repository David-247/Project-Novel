import type { Editor } from '@tiptap/core'
import { useSyncExternalStore } from 'react'
import { getEditor, subscribeEditor } from '../controller'

/** The mounted editor (or null); re-renders when it mounts/unmounts. */
export function useEditorInstance(): Editor | null {
  return useSyncExternalStore(subscribeEditor, getEditor, () => null)
}

/** Platform-correct label for the Mod key (Cmd on macOS/iOS, Ctrl elsewhere). */
export const IS_MAC =
  typeof navigator !== 'undefined' && /Mac|iP(hone|[oa]d)/.test(navigator.platform ?? '')

/** `aria-keyshortcuts` value for a Mod-<key> shortcut. */
export function modShortcut(key: string, shift = false): string {
  return `${IS_MAC ? 'Meta' : 'Control'}+${shift ? 'Shift+' : ''}${key}`
}
