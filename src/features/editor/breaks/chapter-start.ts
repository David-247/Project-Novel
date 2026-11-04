import { STYLE_IDS, writeStyle } from '@/shared/book'
import { useStore } from '@/shared/store'
import { getStyleDefinition, ownDef } from '../styles/actions'
import { getResolvedStyles } from '../styles/resolved'

export type ChaptersStartOn = 'page' | 'recto'

/** Where chapters open: 'page' = next page, 'recto' = next right-hand page (from the Chapter Title style). */
export function getChaptersStartOn(): ChaptersStartOn {
  return getResolvedStyles().get(STYLE_IDS.chapterTitle)?.breakBefore === 'recto' ? 'recto' : 'page'
}

/**
 * Book-level setting "Chapters start on": rewrites `breakBefore` of the Chapter Title style (and of
 * Chapter Number, which opens a chapter the same way, while it breaks at all). One store update.
 */
export function setChaptersStartOn(value: ChaptersStartOn): void {
  const resolved = getResolvedStyles()
  useStore.getState().bookActions.setStyles((sheet) => {
    let next = sheet
    for (const id of [STYLE_IDS.chapterTitle, STYLE_IDS.chapterNumber]) {
      const def = getStyleDefinition(id)
      const current = resolved.get(id)?.breakBefore
      if (!def || (id === STYLE_IDS.chapterNumber && (!current || current === 'none'))) continue
      next = writeStyle(next, id, { ...ownDef(def), breakBefore: value })
    }
    return next
  })
}
