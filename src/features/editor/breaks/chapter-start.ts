import { chapterRoles, STYLE_IDS, writeStyle } from '@/shared/book'
import { useStore } from '@/shared/store'
import { getStyleDefinition, ownDef } from '../styles/actions'
import { getResolvedStyles } from '../styles/resolved'

export type ChaptersStartOn = 'page' | 'recto'

/** Where chapters open: 'page' = next page, 'recto' = next right-hand page (from the Chapter Title style). */
export function getChaptersStartOn(): ChaptersStartOn {
  return getResolvedStyles().get(STYLE_IDS.chapterTitle)?.breakBefore === 'recto' ? 'recto' : 'page'
}

/**
 * Book-level setting "Chapters start on": rewrites `breakBefore` of Chapter Title, and of every other
 * chapter-opening style (a chapter title or chapter number style, `chapterRoles`: Chapter Number, a
 * duplicate of Chapter Title, ...) while it breaks at all. A style that never breaks keeps 'none'. A
 * style with no break of its own, inheriting it from a style rewritten here, is left alone: it follows
 * its parent, and later edits to the parent still reach it. One store update.
 */
export function setChaptersStartOn(value: ChaptersStartOn): void {
  const resolved = getResolvedStyles()
  const ids = [STYLE_IDS.chapterTitle as string, ...[...chapterRoles(resolved).keys()].filter((id) => id !== STYLE_IDS.chapterTitle)]
  const rewritten = new Set<string>()
  for (const id of ids) {
    const current = resolved.get(id)?.breakBefore
    if (getStyleDefinition(id) && (id === STYLE_IDS.chapterTitle || current === 'page' || current === 'recto')) rewritten.add(id)
  }
  /** The style `id` takes its break from: itself when it sets one, else the nearest parent that does. */
  const breakSource = (id: string): string | undefined => {
    for (let cur: string | undefined = id, guard = 0; cur && guard < 64; cur = resolved.get(cur)?.basedOn, guard++) {
      if (getStyleDefinition(cur)?.breakBefore !== undefined) return cur
    }
    return undefined
  }
  useStore.getState().bookActions.setStyles((sheet) => {
    let next = sheet
    for (const id of rewritten) {
      const def = getStyleDefinition(id)!
      const source = breakSource(id)
      if (source && source !== id && rewritten.has(source)) continue // inherited: follows its parent
      next = writeStyle(next, id, { ...ownDef(def), breakBefore: value })
    }
    return next
  })
}
