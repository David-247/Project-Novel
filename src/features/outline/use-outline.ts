import { useEffect, useState } from 'react'
import type { Editor } from '@tiptap/core'
import { Mapping } from '@tiptap/pm/transform'
import { useStore } from '@/shared/store'
import { countOutline } from './counts'
import { assignIds } from './identity'
import { buildOutline, type Outline } from './model'

export interface OutlineData {
  outline: Outline
  /** Words per entry key. */
  words: Map<string, number>
  /** Stable id per entry key: a chapter keeps its id when others are added or removed above it (identity.ts). */
  ids: ReadonlyMap<string, string>
  /** The edits since this build: carries its positions to the document as it is now (read when a row is activated). */
  since: Mapping
}

type IdleWindow = Window & {
  requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number
  cancelIdleCallback?: (id: number) => void
}

/** An idle callback still runs after this long on a busy main thread. */
const IDLE_TIMEOUT_MS = 300

/** Run `fn` when the main thread is idle (a plain task where the engine has no idle callbacks: WebKit). */
function whenIdle(fn: () => void): () => void {
  const w = window as IdleWindow
  if (w.requestIdleCallback) {
    const id = w.requestIdleCallback(fn, { timeout: IDLE_TIMEOUT_MS })
    return () => w.cancelIdleCallback?.(id)
  }
  const t = setTimeout(fn, 0)
  return () => clearTimeout(t)
}

/** Debug counters (unit tests, e2e). */
export const outlineDebug = { builds: 0, lastBuildMs: 0 }

/**
 * The Headings tree with its word counts, while `enabled` (the pane is shown): rebuilt in idle time
 * after each word count publish (itself throttled off the typing path by the editor slice), a style
 * sheet change (chapter openings move) and a markup view switch (what shows a title). Never on a
 * keystroke. The same object comes back while nothing it shows changed, so the tree does not re-render.
 */
export function useOutline(editor: Editor | null, enabled: boolean): OutlineData | null {
  const [state, setState] = useState<{ editor: Editor; data: OutlineData } | null>(null)
  useEffect(() => {
    if (!enabled || !editor) return
    let cancel: (() => void) | null = null
    let last: { doc: unknown; outline: Outline; wc: unknown; data: OutlineData } | null = null
    let minted = 0
    const mint = (kind: string) => `${kind}#${++minted}`
    // The edits since the last build (its `since`), for the ids of the next build and for activating a row.
    let since = new Mapping()
    const onTransaction = ({ transaction }: { transaction: { docChanged: boolean; mapping: Mapping } }) => {
      if (transaction.docChanged) since.appendMapping(transaction.mapping)
    }
    editor.on('transaction', onTransaction)
    const run = () => {
      cancel = null
      if (editor.isDestroyed) return
      const t0 = performance.now()
      const s = useStore.getState()
      const doc = editor.state.doc
      const outline = buildOutline(doc, undefined, s.trackChanges.markupView)
      // Same document, outline and counts: keep the object (no re-render).
      if (last && last.doc === doc && last.outline === outline && last.wc === s.wordCount) return
      const words = countOutline(doc, outline, s.wordCount, s.editor.docVersion)
      const prev = last?.data
      const same = prev && prev.outline === outline && prev.words.size === words.size && [...words].every(([k, n]) => prev.words.get(k) === n)
      let next: OutlineData
      if (same) next = prev
      else if (prev && prev.outline === outline) next = { ...prev, words }
      else {
        // A new outline: its ids continue the last build's through the edits since (`since`), and it
        // starts its own run of edits.
        const ids = assignIds(prev ?? null, outline, mint)
        since = new Mapping()
        next = { outline, words, ids, since }
      }
      last = { doc, outline, wc: s.wordCount, data: next }
      outlineDebug.builds++
      outlineDebug.lastBuildMs = performance.now() - t0
      setState((prev) => (prev?.editor === editor && prev.data === next ? prev : { editor, data: next }))
    }
    const schedule = () => {
      if (!cancel) cancel = whenIdle(run)
    }
    // The first build too (the pane just opened): its rows render a frame later at most.
    schedule()
    const off = useStore.subscribe((s, p) => {
      if (s.wordCount !== p.wordCount || s.book.styles !== p.book.styles || s.trackChanges.markupView !== p.trackChanges.markupView) schedule()
    })
    return () => {
      off()
      editor.off('transaction', onTransaction)
      cancel?.()
    }
  }, [editor, enabled])
  return enabled && editor && state?.editor === editor ? state.data : null
}

/** How long after a caret move the highlighted heading follows (one update per burst of moves). */
const CARET_FOLLOW_MS = 60

/**
 * The document position the pane highlights, as Word highlights the heading you are in: the caret
 * while its page is in view; the top of the spread in view once the view is scrolled or turned away
 * from it. Caret moves are read in a short timer, never in the transaction itself.
 */
export function useCurrentPosition(editor: Editor | null, enabled: boolean): number | null {
  const [head, setHead] = useState<number | null>(null)
  const currentPage = useStore((s) => s.layout.currentPage)
  const first = useStore((s) => s.layout.visibleSpread.first)
  const last = useStore((s) => s.layout.visibleSpread.last)
  const pages = useStore((s) => s.layout.pages)
  useEffect(() => {
    if (!enabled || !editor) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const read = () => {
      timer = null
      if (!editor.isDestroyed) setHead(editor.state.selection.head)
    }
    const onTransaction = ({ transaction }: { transaction: { docChanged: boolean; selectionSet: boolean } }) => {
      if ((transaction.selectionSet || transaction.docChanged) && timer === null) timer = setTimeout(read, CARET_FOLLOW_MS)
    }
    timer = setTimeout(read, 0)
    editor.on('transaction', onTransaction)
    return () => {
      editor.off('transaction', onTransaction)
      if (timer !== null) clearTimeout(timer)
    }
  }, [editor, enabled])
  if (!enabled || head === null) return null
  if (!pages.length || (currentPage >= first && currentPage <= last)) return head
  for (let i = first; i <= last && i < pages.length; i++) if (!pages[i].isBlank) return pages[i].from
  return head
}
