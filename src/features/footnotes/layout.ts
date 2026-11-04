/**
 * Footnote areas: which footnote lines go at the bottom of which page. Pure (no DOM), unit-tested.
 *
 * Footnote texts are laid out in whole lines of one height (the Footnote Text line height), so a
 * note's size is its line count and a split falls between two lines. A page's area holds, in order:
 * the rest of notes continued from earlier pages, then the notes whose references are on the page,
 * up to the page's capacity; what does not fit continues on the next page. The area's height is
 * `top + lines x lineHeight` (top: the space and separator rule above the first note); 0 when empty.
 *
 * Monotone: fewer body lines on a page mean fewer references, so never a taller area. That is what
 * the pagination slice's bottom-reservation loop needs to converge (docs/pagination.md).
 */

/** Part of a note still to be placed: lines `[start, lineCount)` of note `note`. */
export interface PendingNote {
  note: number
  start: number
}

/** Lines `[start, start + count)` of note `note` shown on a page. */
export interface AreaEntry {
  note: number
  start: number
  count: number
}

export interface PageArea {
  entries: AreaEntry[]
  /** Lines in the area. */
  lines: number
  /** Area height in px (0 when empty). */
  height: number
  /** The first entry continues a note from an earlier page. */
  continued: boolean
  /** Notes not (fully) placed: they continue on the next page. */
  carryOut: PendingNote[]
}

export interface AreaMetrics {
  /** Px of one footnote line. */
  lineHeight: number
  /** Px above the first note (space + separator rule). */
  top: number
  /** Most px the area may take on the page. */
  maxHeight: number
}

/** Lines that fit in an area of at most `maxHeight` px (at least 1, so notes always progress). */
export function capacityLines(m: AreaMetrics): number {
  if (!(m.lineHeight > 0)) return 0
  return Math.max(1, Math.floor((m.maxHeight - m.top + 0.01) / m.lineHeight))
}

/**
 * The area of one page: `carryIn` (continued notes), then `notes` (references on the page, in
 * document order), each with `lineCounts[note]` lines, filled up to the capacity.
 */
export function allocateArea(carryIn: readonly PendingNote[], notes: readonly number[], lineCounts: readonly number[], m: AreaMetrics): PageArea {
  const queue: PendingNote[] = [...carryIn, ...notes.map((note) => ({ note, start: 0 }))]
  if (queue.length === 0) return { entries: [], lines: 0, height: 0, continued: false, carryOut: [] }
  let room = capacityLines(m)
  const entries: AreaEntry[] = []
  let i = 0
  for (; i < queue.length && room > 0; i++) {
    const q = queue[i]
    const left = Math.max(0, (lineCounts[q.note] ?? 1) - q.start)
    const count = Math.min(left, room)
    if (count > 0) entries.push({ note: q.note, start: q.start, count })
    room -= count
    if (count < left) {
      // Split: the rest of this note continues on the next page.
      queue[i] = { note: q.note, start: q.start + count }
      break
    }
  }
  const carryOut = queue.slice(i)
  const lines = entries.reduce((s, e) => s + e.count, 0)
  return {
    entries,
    lines,
    height: lines > 0 ? m.top + lines * m.lineHeight : 0,
    continued: entries.length > 0 && entries[0].start > 0,
    carryOut,
  }
}

/** Index of the first `positions[i] >= pos` (positions sorted ascending). */
export function lowerBound(positions: readonly number[], pos: number): number {
  let lo = 0
  let hi = positions.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (positions[mid] < pos) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** Indices of the notes whose reference lies in `[from, to)`. */
export function notesInRange(positions: readonly number[], from: number, to: number): number[] {
  const out: number[] = []
  for (let i = lowerBound(positions, from); i < positions.length && positions[i] < to; i++) out.push(i)
  return out
}

/** A page as the pagination engine asks about it (see the pagination slice's ReservationPage). */
export interface CandidatePage {
  index: number
  from: number
  to: number
}

/**
 * One breaking run of the pagination engine. The engine asks for every page in order, possibly
 * several times for the same page (each time with fewer lines); a run starts at page 0. A page's
 * area depends on the notes continued from the page before, so the run keeps each page's latest
 * answer: the last answer for a page is its final one.
 */
export class FootnoteRun {
  readonly areas: PageArea[] = []
  private carryIn: PendingNote[][] = []
  private lastIndex = -1

  constructor(
    /** Reference positions, ascending. */
    readonly positions: readonly number[],
    readonly lineCounts: readonly number[],
    readonly metrics: AreaMetrics,
    /** Document size: the page ending there is the last one and may use the whole text block. */
    readonly docSize: number,
    /** Text block height (px). */
    readonly textHeight: number,
  ) {}

  /** Px to reserve at the bottom of `page`. */
  reserve(page: CandidatePage): number {
    if (this.positions.length === 0) return 0
    if (page.index !== this.lastIndex) {
      // The previous page is final: its leftovers continue here.
      this.carryIn[page.index] = this.lastIndex >= 0 ? (this.areas[this.lastIndex]?.carryOut ?? []) : []
      this.lastIndex = page.index
    }
    const notes = notesInRange(this.positions, page.from, page.to)
    const m = page.to >= this.docSize ? { ...this.metrics, maxHeight: this.textHeight } : this.metrics
    const area = allocateArea(this.carryIn[page.index] ?? [], notes, this.lineCounts, m)
    this.areas[page.index] = area
    return area.height
  }
}
