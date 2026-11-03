/**
 * Minimal document contract shared between the editor and storage slices.
 *
 * The editor (ProseMirror/Tiptap) is the single source of truth for document
 * content. It registers a DocumentProvider here; storage reads and writes the
 * document only through this interface, never through editor internals.
 */

/** A ProseMirror node in JSON form (`node.toJSON()`). */
export interface DocNodeJSON {
  type: string
  attrs?: Record<string, unknown>
  content?: DocNodeJSON[]
  marks?: { type: string; attrs?: Record<string, unknown> }[]
  text?: string
}

/** A whole ProseMirror document in JSON form: the root node has type "doc". */
export interface DocJSON extends DocNodeJSON {
  type: 'doc'
}

export interface DocumentProvider {
  /** Current document as ProseMirror JSON. */
  getDocJSON(): DocJSON
  /** Replace the whole document (e.g. after opening a project). */
  setDocJSON(doc: DocJSON): void
  /** True if the document changed since the last `markClean()`. */
  isDirty(): boolean
  /** Mark the current content as saved. */
  markClean(): void
  /** Subscribe to content changes. Returns an unsubscribe function. */
  onDocChange(cb: () => void): () => void
}

/** An empty document: one empty paragraph. */
export function emptyDoc(): DocJSON {
  return { type: 'doc', content: [{ type: 'paragraph' }] }
}

let current: DocumentProvider | null = null
const providerListeners = new Set<(p: DocumentProvider | null) => void>()

/** Register the active document provider. Returns a function that unregisters it. */
export function registerDocumentProvider(p: DocumentProvider): () => void {
  current = p
  providerListeners.forEach((cb) => cb(p))
  return () => {
    if (current === p) {
      current = null
      providerListeners.forEach((cb) => cb(null))
    }
  }
}

/** The active document provider, or null if none is registered yet. */
export function getDocumentProvider(): DocumentProvider | null {
  return current
}

/** Be notified when the active provider is registered or removed. Returns unsubscribe. */
export function onDocumentProviderChange(cb: (p: DocumentProvider | null) => void): () => void {
  providerListeners.add(cb)
  return () => providerListeners.delete(cb)
}

/**
 * A plain in-memory provider (no editor). Useful for tests and as a stand-in
 * before an editor registers. `setDocJSON` marks the doc clean; `update` changes
 * it and marks it dirty, like typing would.
 */
export function createMemoryDocumentProvider(
  initial: DocJSON = emptyDoc(),
): DocumentProvider & { update(doc: DocJSON): void } {
  let doc = initial
  let dirty = false
  const listeners = new Set<() => void>()
  const notify = () => listeners.forEach((cb) => cb())
  return {
    getDocJSON: () => doc,
    setDocJSON: (d) => {
      doc = d
      dirty = false
      notify()
    },
    update: (d) => {
      doc = d
      dirty = true
      notify()
    },
    isDirty: () => dirty,
    markClean: () => {
      dirty = false
    },
    onDocChange: (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
  }
}
