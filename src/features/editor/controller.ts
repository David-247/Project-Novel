import type { Editor, JSONContent } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import { EditorState } from '@tiptap/pm/state'
import { useStore } from '@/shared/store'

/**
 * Module-level bridge between the mounted Tiptap editor and the rest of the
 * app. The ProseMirror doc stays the single source of truth; the store only
 * receives O(1) derived flags per change (never the doc JSON).
 */

export type DocChangeListener = () => void

const EMPTY_DOC: JSONContent = { type: 'doc', content: [{ type: 'paragraph' }] }

let current: Editor | null = null
let pending: JSONContent | null = null
const docListeners = new Set<DocChangeListener>()
const editorListeners = new Set<() => void>()

const actions = () => useStore.getState().editorActions

function isEmptyNode(doc: PMNode): boolean {
  const first = doc.firstChild
  return doc.childCount === 1 && !!first && first.isTextblock && first.content.size === 0
}

function isEmptyJSON(doc: JSONContent): boolean {
  const c = doc.content ?? []
  return c.length === 0 || (c.length === 1 && !(c[0].content && c[0].content.length > 0))
}

function live(): Editor | null {
  return current && !current.isDestroyed ? current : null
}

function notifyEditorListeners() {
  editorListeners.forEach((cb) => cb())
}

/** Replace the editor state wholesale: new doc, fresh undo history, no update event. */
function loadInto(editor: Editor, doc: JSONContent) {
  const node = editor.schema.nodeFromJSON(doc)
  node.check()
  const state = EditorState.create({ schema: editor.schema, doc: node, plugins: editor.state.plugins })
  editor.view.updateState(state)
  actions().docLoaded(isEmptyNode(node))
}

/** Internal: called by `NovelEditor` when its editor instance is ready. Returns detach. */
export function attachEditor(editor: Editor): () => void {
  current = editor
  const onUpdate = ({ editor: ed }: { editor: Editor }) => {
    actions().docChanged(isEmptyNode(ed.state.doc))
    docListeners.forEach((cb) => cb())
  }
  editor.on('update', onUpdate)
  if (pending) {
    const doc = pending
    pending = null
    loadInto(editor, doc)
  }
  notifyEditorListeners()
  return () => {
    editor.off('update', onUpdate)
    if (current === editor) {
      current = null
      notifyEditorListeners()
    }
  }
}

/** Subscribe to the mounted editor appearing/disappearing (for `useSyncExternalStore`). */
export function subscribeEditor(cb: () => void): () => void {
  editorListeners.add(cb)
  return () => editorListeners.delete(cb)
}

/** The mounted editor, or null when none is mounted. */
export function getEditor(): Editor | null {
  return live()
}

/** Current document as ProseMirror JSON (O(n); call on save, not per keystroke). */
export function getDocJSON(): JSONContent {
  const ed = live()
  if (ed) return ed.getJSON()
  return structuredClone(pending ?? EMPTY_DOC)
}

/**
 * Load a document: replaces content, resets undo history, clears dirty.
 * Does not fire `onDocChange`. If no editor is mounted yet, it is applied on mount.
 * Throws if `doc` does not fit the schema.
 */
export function setDocJSON(doc: JSONContent): void {
  const ed = live()
  if (ed) {
    loadInto(ed, doc)
  } else {
    pending = structuredClone(doc)
    actions().docLoaded(isEmptyJSON(doc))
  }
}

/** True when the user edited the doc since the last load / markClean. */
export function isDirty(): boolean {
  return useStore.getState().editor.dirty
}

/** Mark the current content as persisted. */
export function markClean(): void {
  actions().markClean()
}

/** Called after every user edit that changes the doc (not on `setDocJSON`). Returns unsubscribe. */
export function onDocChange(cb: DocChangeListener): () => void {
  docListeners.add(cb)
  return () => {
    docListeners.delete(cb)
  }
}
