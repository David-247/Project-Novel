import type { Node as PMNode } from '@tiptap/pm/model'
import { useSyncExternalStore } from 'react'
import { getFootnotes, getEditor, getResolvedStyles, SYSTEM_FONT_STACK, type FootnoteRef } from '@/features/editor'
import { resolvePageGeometry, type ReservationPage } from '@/features/pagination'
import { useStore } from '@/shared/store'
import { FootnoteRun } from './layout'
import { MAX_AREA_SHARE, measureNotes, noteStyle, type NoteStyle } from './note-dom'

/** One note's lines drawn in a page's footnote area. */
export interface DrawnNote {
  node: PMNode
  label: string
  ordinal: number
  start: number
  count: number
}

/** What one page's footnote area shows (published after every pagination pass). */
export interface DrawnArea {
  height: number
  top: number
  lineHeight: number
  separator: boolean
  continued: boolean
  css: Record<string, string>
  notes: DrawnNote[]
}

interface Run {
  refs: readonly FootnoteRef[]
  style: NoteStyle
  pages: FootnoteRun
}

let run: Run | null = null
let publishQueued = false

function startRun(): Run | null {
  const editor = getEditor()
  if (!editor || editor.isDestroyed) return null
  const refs = getFootnotes()
  const { book } = useStore.getState()
  const geometry = resolvePageGeometry(book.trimSize, book.margins)
  const style = noteStyle(getResolvedStyles(), geometry, book.footnotes, SYSTEM_FONT_STACK)
  const metrics = { lineHeight: style.lineHeight, top: style.top, maxHeight: style.height * MAX_AREA_SHARE }
  const pages = new FootnoteRun(
    refs.map((r) => r.pos),
    measureNotes(refs, style),
    metrics,
    editor.state.doc.content.size,
    style.height,
  )
  return { refs, style, pages }
}

/** The `registerBottomReservation` callback: px of footnotes at the bottom of `page` (a run starts at page 0). */
export function reserveFootnotes(page: ReservationPage): number {
  if (page.index === 0 || !run) run = startRun()
  if (!run || run.refs.length === 0) return 0
  const h = run.pages.reserve(page)
  // Publish once the engine's (synchronous) breaking run is over, before the frame is painted.
  if (!publishQueued) {
    publishQueued = true
    queueMicrotask(publish)
  }
  return h
}

// ---- Published areas ---------------------------------------------------------------------------

let drawn: readonly (DrawnArea | undefined)[] = []
const listeners = new Set<() => void>()

function sameArea(a: DrawnArea | undefined, b: DrawnArea): boolean {
  if (!a || a.height !== b.height || a.top !== b.top || a.separator !== b.separator || a.continued !== b.continued) return false
  if (a.lineHeight !== b.lineHeight || a.css !== b.css || a.notes.length !== b.notes.length) return false
  return a.notes.every((n, i) => {
    const m = b.notes[i]
    return n.node === m.node && n.label === m.label && n.start === m.start && n.count === m.count && n.ordinal === m.ordinal
  })
}

function publish() {
  publishQueued = false
  const r = run
  if (!r) return
  const prev = drawn
  // One css object per style, so unchanged areas compare equal.
  const css = prev.find((a) => a && JSON.stringify(a.css) === JSON.stringify(r.style.css))?.css ?? r.style.css
  const next: (DrawnArea | undefined)[] = []
  let changed = prev.length !== r.pages.areas.length
  r.pages.areas.forEach((area, i) => {
    if (!area || area.entries.length === 0) {
      if (prev[i]) changed = true
      return
    }
    const d: DrawnArea = {
      height: area.height,
      top: r.style.top,
      lineHeight: r.style.lineHeight,
      separator: r.style.separator,
      continued: area.continued,
      css,
      notes: area.entries.map((e) => ({ node: r.refs[e.note].node, label: r.refs[e.note].label, ordinal: e.note, start: e.start, count: e.count })),
    }
    if (sameArea(prev[i], d)) next[i] = prev[i]
    else {
      next[i] = d
      changed = true
    }
  })
  if (!changed) return
  drawn = next
  listeners.forEach((l) => l())
}

/** Drop the published areas (no footnotes left, or the editor went away). */
export function clearAreas(): void {
  run = null
  if (drawn.length === 0) return
  drawn = []
  listeners.forEach((l) => l())
}

/** Px of footnotes at the bottom of each page index (diagnostics, e2e). */
export function footnoteAreaHeights(): number[] {
  return Array.from(drawn, (a) => a?.height ?? 0)
}

/** Lines of each note placed on each page (tests): `[page][k] = { ordinal, start, count }`. */
export function footnotePlacement(): { ordinal: number; start: number; count: number }[][] {
  return Array.from(drawn, (a) => a?.notes.map(({ ordinal, start, count }) => ({ ordinal, start, count })) ?? [])
}

function subscribe(cb: () => void) {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function useDrawnArea(pageIndex: number): DrawnArea | undefined {
  return useSyncExternalStore(
    subscribe,
    () => drawn[pageIndex],
    () => undefined,
  )
}
