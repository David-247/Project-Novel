import { getSchema, type Editor, type JSONContent } from '@tiptap/core'
import type { Node as PMNode, Schema } from '@tiptap/pm/model'
import { EditorState } from '@tiptap/pm/state'
import { useStore } from '@/shared/store'
import { createEditorExtensions } from './extensions'

/**
 * Module-level bridge between the mounted Tiptap editor and the rest of the
 * app. The ProseMirror doc stays the single source of truth; the store only
 * receives O(1) derived flags per change (never the doc JSON).
 */

export type DocChangeListener = () => void

const EMPTY_DOC: JSONContent = { type: 'doc', content: [{ type: 'paragraph' }] }

let current: Editor | null = null
/** Doc to load on the next mount: from a pre-mount `setDocJSON` or an unmount snapshot. */
let pending: JSONContent | null = null
/** Set when `pending` is an unmount snapshot of this editor (so re-attaching it is a no-op). */
let pendingSnapshotOf: Editor | null = null
let loadCount = 0
const docListeners = new Set<DocChangeListener>()
const editorListeners = new Set<() => void>()
const loadListeners = new Set<() => void>()

const actions = () => useStore.getState().editorActions

let detachedSchema: Schema | null = null
function schemaForValidation(): Schema {
  detachedSchema ??= getSchema(createEditorExtensions())
  return detachedSchema
}

function isEmptyNode(doc: PMNode): boolean {
  const first = doc.firstChild
  return doc.childCount === 1 && !!first && first.isTextblock && first.content.size === 0
}

function live(): Editor | null {
  return current && !current.isDestroyed ? current : null
}

function notify(listeners: Set<() => void>) {
  listeners.forEach((cb) => cb())
}

/**
 * Replace the editor state wholesale: new doc, fresh undo history, no update event.
 * `keepDirty` restores an unmount snapshot without losing its unsaved status.
 */
function loadInto(editor: Editor, doc: JSONContent, keepDirty = false) {
  const node = editor.schema.nodeFromJSON(doc)
  node.check()
  const state = EditorState.create({ schema: editor.schema, doc: node, plugins: editor.state.plugins })
  editor.view.updateState(state)
  if (keepDirty && useStore.getState().editor.dirty) actions().docChanged(isEmptyNode(node))
  else actions().docLoaded(isEmptyNode(node))
  loadCount++
  notify(loadListeners)
}

/** Internal: called by `NovelEditor` when its editor instance is ready. Returns detach. */
export function attachEditor(editor: Editor): () => void {
  current = editor
  if (pending && pendingSnapshotOf !== editor) {
    const doc = pending
    const isSnapshot = pendingSnapshotOf !== null
    try {
      loadInto(editor, doc, isSnapshot)
    } catch (err) {
      console.error('[editor] could not load pending document; starting empty', err)
      loadInto(editor, EMPTY_DOC)
    }
  }
  pending = null
  pendingSnapshotOf = null

  const onUpdate = ({ editor: ed }: { editor: Editor }) => {
    actions().docChanged(isEmptyNode(ed.state.doc))
    docListeners.forEach((cb) => cb())
  }
  editor.on('update', onUpdate)
  notify(editorListeners)

  return () => {
    editor.off('update', onUpdate)
    if (current !== editor) return
    if (!editor.isDestroyed) {
      // Keep the content reachable via getDocJSON() and restorable on remount.
      pending = editor.getJSON()
      pendingSnapshotOf = editor
    }
    current = null
    notify(editorListeners)
  }
}

/** Subscribe to the mounted editor appearing/disappearing (for `useSyncExternalStore`). */
export function subscribeEditor(cb: () => void): () => void {
  editorListeners.add(cb)
  return () => editorListeners.delete(cb)
}

/** Subscribe to whole-document loads (setDocJSON / mount restore). Internal. */
export function subscribeDocLoad(cb: () => void): () => void {
  loadListeners.add(cb)
  return () => loadListeners.delete(cb)
}

/** Number of whole-document loads so far. Internal (`useSyncExternalStore` snapshot). */
export function getLoadCount(): number {
  return loadCount
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
 * Does not fire `onDocChange`. If no editor is mounted yet, it is validated now
 * and applied on mount. Throws (leaving state untouched) if `doc` does not fit the schema.
 */
export function setDocJSON(doc: JSONContent): void {
  const ed = live()
  if (ed) {
    loadInto(ed, doc)
    return
  }
  const node = schemaForValidation().nodeFromJSON(doc)
  node.check()
  pending = structuredClone(doc)
  pendingSnapshotOf = null
  actions().docLoaded(isEmptyNode(node))
  loadCount++
  notify(loadListeners)
}

/** True when the user edited the doc since the last load / markClean. */
export function isDirty(): boolean {
  return useStore.getState().editor.dirty
}

/** Current document version (increments on every edit and load). */
export function getDocVersion(): number {
  return useStore.getState().editor.docVersion
}

/**
 * Mark content as persisted. With `version` (the `getDocVersion()` value read
 * when the save snapshot was taken), dirty is cleared only if no edit happened
 * since; without it, dirty is cleared unconditionally.
 */
export function markClean(version?: number): void {
  actions().markClean(version)
}

/**
 * Flag the current content as unsaved without changing it (e.g. after storage
 * restored crash-recovery data with `setDocJSON`). Bumps the doc version like
 * an edit but does NOT fire `onDocChange` listeners.
 */
export function markDirty(): void {
  actions().docChanged(useStore.getState().editor.isEmpty)
}

/** Called after every user edit that changes the doc (not on `setDocJSON`). Returns unsubscribe. */
export function onDocChange(cb: DocChangeListener): () => void {
  docListeners.add(cb)
  return () => {
    docListeners.delete(cb)
  }
}
