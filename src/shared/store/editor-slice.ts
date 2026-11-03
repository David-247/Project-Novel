import type { SliceCreator } from './types'

/**
 * Lightweight, derived editor state. The ProseMirror document itself is the
 * single source of truth for content and is NEVER copied into the store
 * (typing latency budget); read it via `getDocJSON()` from `@/features/editor`.
 */
export interface EditorSlice {
  editor: {
    /** True when the document holds only an empty paragraph. */
    isEmpty: boolean
    /** Increments on every content change (user edit or load). */
    docVersion: number
    /** True when there are user edits since the last load / markClean. */
    dirty: boolean
  }
  /** Named actions: the only way to change `editor` state. */
  editorActions: {
    /** A user edit changed the document. */
    docChanged: (isEmpty: boolean) => void
    /** A document was loaded (history reset); clears dirty. */
    docLoaded: (isEmpty: boolean) => void
    /** Content was persisted; clears dirty. */
    markClean: () => void
  }
}

export const createEditorSlice: SliceCreator<EditorSlice> = (set) => ({
  editor: { isEmpty: true, docVersion: 0, dirty: false },
  editorActions: {
    docChanged: (isEmpty) =>
      set((s) => ({ editor: { isEmpty, docVersion: s.editor.docVersion + 1, dirty: true } })),
    docLoaded: (isEmpty) =>
      set((s) => ({ editor: { isEmpty, docVersion: s.editor.docVersion + 1, dirty: false } })),
    markClean: () =>
      set((s) => (s.editor.dirty ? { editor: { ...s.editor, dirty: false } } : s)),
  },
})
