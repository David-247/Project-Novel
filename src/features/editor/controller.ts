import { getSchema, type Editor, type JSONContent } from '@tiptap/core'
import type { Node as PMNode, Schema } from '@tiptap/pm/model'
import { EditorState, type Transaction } from '@tiptap/pm/state'
import { useStore } from '@/shared/store'
import { TRACKING_BLOCK_ATTRS } from '@/shared/track-changes'
import { REWRITE_BLOCK_ATTR } from '@/shared/rewrite'
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

/**
 * Parse and validate a doc. A doc with no blocks (`{"type":"doc","content":[]}`, e.g. a
 * hand-edited or third-party manuscript) is completed to one empty paragraph instead of
 * being rejected; anything else the schema rejects throws.
 */
function docFromJSON(schema: Schema, doc: JSONContent): PMNode {
  let node = schema.nodeFromJSON(doc)
  if (node.type === schema.topNodeType && node.childCount === 0) node = schema.topNodeType.createAndFill()!
  node.check()
  return node
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
  const node = docFromJSON(editor.schema, doc)
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
  // A document step that leaves the text equal (a comment thread change, its undo) is still an
  // unsaved change: Tiptap emits no 'update' for it.
  const onTransaction = ({ editor: ed, transaction: tr }: { editor: Editor; transaction: Transaction }) => {
    if (tr.docChanged && !tr.getMeta('preventUpdate') && tr.before.eq(tr.doc)) onUpdate({ editor: ed })
  }
  editor.on('transaction', onTransaction)
  notify(editorListeners)

  return () => {
    editor.off('update', onUpdate)
    editor.off('transaction', onTransaction)
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

/**
 * Where text commands act (Edit history / clipboard, Insert, Format, styles: the menus, their
 * shortcuts, native menu items). Normally the manuscript. Another view that edits text in place of
 * the manuscript (the re-write view) registers a source while it is shown: its editor while that has
 * the focus, else null (the commands are then disabled).
 */
let activeSource: (() => Editor | null) | null = null
const activeListeners = new Set<() => void>()

export function setActiveEditorSource(source: (() => Editor | null) | null): () => void {
  activeSource = source
  activeListeners.forEach((l) => l())
  return () => {
    if (activeSource !== source) return
    activeSource = null
    activeListeners.forEach((l) => l())
  }
}

/** Notify command state readers that the active editor (or its focus) changed. */
export function onActiveEditorChange(cb: () => void): () => void {
  activeListeners.add(cb)
  return () => activeListeners.delete(cb)
}

/** The editor text commands act on: the registered source's, else the manuscript. */
export function getActiveEditor(): Editor | null {
  if (!activeSource) return live()
  const ed = activeSource()
  return ed && !ed.isDestroyed ? ed : null
}

/** Tell command readers the active source's editor changed (focus moved into or out of it). */
export function activeEditorChanged(): void {
  activeListeners.forEach((l) => l())
}

/**
 * Optional block layout attributes (formatting toolbar). A block that does not use one gets no
 * entry in the saved JSON; loading a doc without them gives the same defaults.
 */
const OPTIONAL_BLOCK_ATTRS = [
  'textAlign',
  'lineHeight',
  'paragraphSpacing',
  'indent',
  'firstLineIndent',
  'styleId',
  // Track changes (Phase 3): null unless the block carries a tracked change.
  ...TRACKING_BLOCK_ATTRS,
  // Re-write (Phase 3): null unless the block is part of a passage in re-write.
  REWRITE_BLOCK_ATTR,
] as const

/**
 * Drop OPTIONAL_BLOCK_ATTRS that equal the schema default (textAlign/lineHeight/paragraphSpacing/styleId/
 * firstLineIndent null, indent 0) from `json` (its nodes are updated in place, their `attrs` objects
 * are replaced, never mutated), and an `attrs` object left empty. Keeps
 * manuscript.json free of per-paragraph noise without storage knowing the editor schema.
 */
export function stripDefaultBlockAttrs(json: JSONContent, schema: Schema): JSONContent {
  const visit = (node: JSONContent) => {
    const spec = node.type ? schema.nodes[node.type]?.spec.attrs : undefined
    if (node.attrs && spec) {
      // Node.toJSON() shares the live node's attrs object: never delete from it, replace it.
      let attrs: Record<string, unknown> | null = null
      for (const name of OPTIONAL_BLOCK_ATTRS) {
        if (name in node.attrs && name in spec && node.attrs[name] === spec[name].default) {
          attrs ??= { ...node.attrs }
          delete attrs[name]
        }
      }
      if (attrs) {
        if (Object.keys(attrs).length === 0) delete node.attrs
        else node.attrs = attrs
      }
    }
    node.content?.forEach(visit)
  }
  visit(json)
  return json
}

/** Current document as ProseMirror JSON, default block attrs stripped (O(n); call on save, not per keystroke). */
export function getDocJSON(): JSONContent {
  const ed = live()
  if (ed) return stripDefaultBlockAttrs(ed.getJSON(), ed.schema)
  return stripDefaultBlockAttrs(structuredClone(pending ?? EMPTY_DOC), schemaForValidation())
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
  const node = docFromJSON(schemaForValidation(), doc)
  pending = doc.content?.length ? structuredClone(doc) : (node.toJSON() as JSONContent)
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
