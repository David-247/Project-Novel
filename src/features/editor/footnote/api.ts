import { getEditor } from '../controller'
import { footnotesOf, type FootnoteRef } from './numbering'

/** The mounted editor's footnotes in document order, numbered (empty when no editor is mounted). */
export function getFootnotes(): readonly FootnoteRef[] {
  const ed = getEditor()
  return ed && !ed.isDestroyed ? footnotesOf(ed.state) : []
}
