import { getChapters, getEditor, onDocChange } from '@/features/editor'
import type { Chapter } from '@/features/editor'
import { makeHeaderFooterResolver, type HFPage, type HeaderFooterSettings, type ResolvedHeaderFooter } from '@/shared/book'
import { useStore, type RootState } from '@/shared/store'

/**
 * What the page slots read. Everything here is derived from the store plus the chapter list, and is
 * cached by identity, so a keystroke costs: one `getChapters` pass (O(top-level blocks), only when
 * the layout was republished) and a handful of ref comparisons per rendered slot. Nothing touches
 * the layout engine, so headers can never cause or influence a reflow.
 */

// ---- Chapters, in step with the published layout -----------------------------------------------

let titlesVersion = 0
let titlesSignature = ''
const titleListeners = new Set<() => void>()

let chaptersCache: { pages: unknown; titlesVersion: number; chapters: Chapter[] } | null = null

/**
 * The chapters of the document as it is when the layout `pages` was published. They are refreshed
 * when the layout is republished (or a chapter title changed), never in between: the chapter
 * positions then agree with the page ranges they are compared against.
 */
export function chaptersFor(pages: unknown): Chapter[] {
  if (chaptersCache && chaptersCache.pages === pages && chaptersCache.titlesVersion === titlesVersion) return chaptersCache.chapters
  const doc = getEditor()?.state.doc
  const chapters = doc ? getChapters(doc) : []
  chaptersCache = { pages, titlesVersion, chapters }
  return chapters
}

const signatureOf = (chapters: readonly Chapter[]) => chapters.map((c) => c.title).join('\u0000')

export function subscribeTitles(cb: () => void): () => void {
  titleListeners.add(cb)
  return () => titleListeners.delete(cb)
}
/** Changes when the list of chapter titles changed (an edit to a title, a chapter added or removed). */
export const getTitlesVersion = (): number => titlesVersion

const usesChapterTitles = (h: HeaderFooterSettings) => h.verso.kind === 'chapter' || h.recto.kind === 'chapter'

/**
 * Watch document edits for chapter title changes while a running head shows the chapter title. The
 * work is deferred to the next frame and coalesced, and skipped entirely for other settings.
 * Returns the unsubscribe.
 */
export function trackChapterTitles(): () => void {
  let frame = 0
  const check = () => {
    frame = 0
    const doc = getEditor()?.state.doc
    if (!doc) return
    const sig = signatureOf(getChapters(doc))
    if (sig === titlesSignature) return
    titlesSignature = sig
    titlesVersion++
    titleListeners.forEach((l) => l())
  }
  const off = onDocChange(() => {
    if (frame || !usesChapterTitles(useStore.getState().book.headerFooter)) return
    frame = requestAnimationFrame(check)
  })
  // Titles edited while no head showed them were not tracked: look again when one starts to.
  const offStore = useStore.subscribe((s, prev) => {
    if (s.book.headerFooter !== prev.book.headerFooter && usesChapterTitles(s.book.headerFooter) && !frame) {
      frame = requestAnimationFrame(check)
    }
  })
  return () => {
    off()
    offStore()
    if (frame) cancelAnimationFrame(frame)
  }
}

// ---- Per-page resolution -----------------------------------------------------------------------

let resolverCache: {
  pages: unknown
  settings: HeaderFooterSettings
  title: string
  author: string
  titlesVersion: number
  resolve: (page: HFPage) => ResolvedHeaderFooter
} | null = null

/** What one page shows, from the store's current layout, settings and project details. */
export function resolvePage(s: RootState, pageIndex: number): ResolvedHeaderFooter | null {
  const pages = s.layout.pages
  const page = pages[pageIndex]
  if (!page) return null
  const settings = s.book.headerFooter
  const title = s.project.title ?? ''
  const author = s.project.author
  const c = resolverCache
  if (!c || c.pages !== pages || c.settings !== settings || c.title !== title || c.author !== author || c.titlesVersion !== titlesVersion) {
    resolverCache = {
      pages,
      settings,
      title,
      author,
      titlesVersion,
      resolve: makeHeaderFooterResolver(pages, chaptersFor(pages), settings, { title, author }),
    }
  }
  return resolverCache!.resolve(page)
}
