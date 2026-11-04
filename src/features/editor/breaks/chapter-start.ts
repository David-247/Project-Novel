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
 * duplicate of Chapter Title, ...) while it breaks at all. A style that never breaks keeps 'none'.
 * One store update.
 */
export function setChaptersStartOn(value: ChaptersStartOn): void {
  const resolved = getResolvedStyles()
  const ids = [STYLE_IDS.chapterTitle as string, ...[...chapterRoles(resolved).keys()].filter((id) => id !== STYLE_IDS.chapterTitle)]
  useStore.getState().bookActions.setStyles((sheet) => {
    let next = sheet
    for (const id of ids) {
      const def = getStyleDefinition(id)
      const current = resolved.get(id)?.breakBefore
      if (!def || (id !== STYLE_IDS.chapterTitle && current !== 'page' && current !== 'recto')) continue
      next = writeStyle(next, id, { ...ownDef(def), breakBefore: value })
    }
    return next
  })
}
