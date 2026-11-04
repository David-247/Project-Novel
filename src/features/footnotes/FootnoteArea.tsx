import { memo, useLayoutEffect, useRef } from 'react'
import { fillNote } from './note-dom'
import { useDrawnArea, type DrawnNote } from './reservation'
import './footnotes.css'

/**
 * The footnote area of one page (a 'reserved' page slot: the text block, behind the text). Anchored
 * at the bottom of the text block, exactly as tall as the space the page reserved for it, so body
 * text never overlaps it. Lines are whole Footnote Text lines; a note continued from the page before
 * shows its next lines (the same note, shifted up and clipped at a line boundary). Display only:
 * notes are edited in the footnote editor, opened from their reference.
 */
export const FootnoteArea = memo(function FootnoteArea({ pageIndex }: { pageIndex: number }) {
  const area = useDrawnArea(pageIndex)
  if (!area) return null
  return (
    <div className="nv-fn-area" data-footnote-area={pageIndex} style={{ ...area.css, height: area.height, paddingTop: area.top }}>
      {area.separator && <div className={area.continued ? 'nv-fn-rule nv-fn-rule--continued' : 'nv-fn-rule'} style={{ top: Math.round(area.top * 0.45) }} />}
      {area.notes.map((n) => (
        <NoteLines key={`${n.ordinal}:${n.start}`} note={n} lineHeight={area.lineHeight} />
      ))}
      {area.clipped && (
        // The last page has no next page for the rest of the note (footnote-only pages: follow-up).
        // Its own line: the last line of the area, which the notes leave free when clipped.
        <span className="nv-fn-clipped" data-footnote-clipped="" style={{ height: area.lineHeight, lineHeight: `${area.lineHeight}px` }}>
          continued…
        </span>
      )}
    </div>
  )
})

function NoteLines({ note, lineHeight }: { note: DrawnNote; lineHeight: number }) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (ref.current) fillNote(ref.current, note.node, note.label)
  }, [note.node, note.label])
  return (
    <div className="nv-fn-note" data-footnote-note={note.ordinal} data-start={note.start} style={{ height: note.count * lineHeight }}>
      <div ref={ref} style={{ marginTop: -note.start * lineHeight }} />
    </div>
  )
}
