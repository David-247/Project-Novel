import type { Editor } from '@tiptap/core'
import type { Transaction } from '@tiptap/pm/state'
import { useStore } from '@/shared/store'
import { getChapters } from '../breaks/chapters'
import { getResolvedStyles } from '../styles/resolved'
import { countManuscript, countRange } from './count'

/**
 * Publishes the manuscript's live counts to the store (`wordCount`, docs/word-count.md), never on the
 * typing path: a change (edit, selection move, document load, style sheet change, which moves chapter
 * openings) arms one timer; when it fires the count runs in an idle callback (a plain task where the
 * engine has none: WebKit). So at most one count per THROTTLE_MS while typing, each reading only the
 * blocks that changed (count.ts caches the rest).
 */
export const WORD_COUNT_THROTTLE_MS = 150
/** An idle callback still runs after this long, on a busy main thread. */
const IDLE_TIMEOUT_MS = 400

type IdleWindow = Window & {
  requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number
  cancelIdleCallback?: (id: number) => void
}

let active: { run: () => void } | null = null

/** Run a pending count now (the Word Count dialog opening, tests). */
export function flushWordCount(): void {
  active?.run()
}

/** Count the mounted manuscript and publish. */
function publish(editor: Editor) {
  if (editor.isDestroyed) return
  const state = editor.state
  const doc = state.doc
  const chapters = getChapters(doc, getResolvedStyles(), 'none')
  const counts = countManuscript(doc, chapters)
  const sel = state.selection
  const selection = sel.empty ? null : { ...countRange(doc, sel.from, sel.to), from: sel.from, to: sel.to }
  const { wordCountActions, editor: ed } = useStore.getState()
  wordCountActions.publish({
    document: { body: counts.body, footnotes: counts.footnotes },
    selection,
    frontMatter: counts.frontMatter,
    chapters: counts.chapters.map((c) => ({ index: c.index, title: c.title, from: c.from, to: c.to, body: c.body, footnotes: c.footnotes })),
    docVersion: ed.docVersion,
  })
}

/**
 * Keep the store's counts current for the manuscript editor (called when it attaches). Returns
 * detach, which clears the counts.
 */
export function attachWordCount(editor: Editor, onDocLoad: (cb: () => void) => () => void): () => void {
  const w = window as IdleWindow
  let timer: ReturnType<typeof setTimeout> | null = null
  let idle: number | null = null
  const cancel = () => {
    if (timer !== null) clearTimeout(timer)
    if (idle !== null) w.cancelIdleCallback?.(idle)
    timer = null
    idle = null
  }
  const run = () => {
    cancel()
    publish(editor)
  }
  const schedule = () => {
    if (timer !== null || idle !== null) return
    timer = setTimeout(() => {
      timer = null
      if (w.requestIdleCallback) idle = w.requestIdleCallback(() => {
        idle = null
        publish(editor)
      }, { timeout: IDLE_TIMEOUT_MS })
      else publish(editor)
    }, WORD_COUNT_THROTTLE_MS)
  }
  const onTransaction = ({ transaction: tr }: { transaction: Transaction }) => {
    if (tr.docChanged || tr.selectionSet) schedule()
  }
  editor.on('transaction', onTransaction)
  const offLoad = onDocLoad(schedule)
  let styles = useStore.getState().book.styles
  const offStore = useStore.subscribe((s) => {
    if (s.book.styles === styles) return
    styles = s.book.styles
    schedule()
  })
  const me = { run }
  active = me
  schedule()
  return () => {
    cancel()
    editor.off('transaction', onTransaction)
    offLoad()
    offStore()
    if (active === me) {
      active = null
      useStore.getState().wordCountActions.reset()
    }
  }
}
