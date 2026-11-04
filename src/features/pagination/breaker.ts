/**
 * Page breaking: a pure function from measured line boxes to page ranges. No DOM, no ProseMirror,
 * so every rule is unit-tested (breaker.test.ts) and engine-independent.
 *
 * Input is the document as one vertical stream of line boxes (px, any origin) grouped into
 * fragmentation units (textblocks: paragraphs, headings, list-item paragraphs). Output pages are
 * half-open line ranges `[startLine, endLine)`. Rules, in order:
 *  1. Fill: lines go on the page while `bottom(line) - top(first line on page) <= available height`.
 *     A page holds at least one line (a line taller than the page still progresses).
 *  2. Forced breaks: a unit with `breakBefore` starts a new page; 'recto' also inserts a blank page
 *     when the new page would be a verso (page 0 is a recto; even index = recto).
 *  3. Widows/orphans (default 2/2): a unit split across pages keeps >= `orphans` lines at the bottom
 *     of the first page and >= `widows` lines at the top of the next; otherwise lines move forward
 *     (or the whole unit moves when it cannot be split that way).
 *  4. Keep with next: a unit flagged `keepWithNext` (headings) never ends a page; it moves to the
 *     next page with the unit that follows (chains of headings move together).
 *  5. Bottom reservations (footnotes): see `BreakOptions.reserve`.
 * When 3 or 4 would leave the page empty, the plain fill break from 1 is used instead.
 */

export type BreakBefore = 'page' | 'recto'

export interface LineBox {
  top: number
  bottom: number
  /** Index of the unit (textblock) this line belongs to. */
  unit: number
}

export interface UnitInfo {
  firstLine: number
  lineCount: number
  breakBefore: BreakBefore | null
  keepWithNext: boolean
}

export interface PageRange {
  startLine: number
  /** Exclusive. */
  endLine: number
  /** A blank verso inserted by a 'recto' break (startLine === endLine). */
  blank: boolean
  /** Px reserved at the bottom (from `reserve`); 0 when nothing was reserved. */
  reserved: number
  /** True when the reservation loop hit its iteration cap (see `reserve`). */
  reserveCapped?: boolean
}

export interface BreakOptions {
  /** Height of the text block (px). */
  contentHeight: number
  widows?: number
  orphans?: number
  /**
   * Bottom reservation for a candidate page holding lines `[startLine, endLine)`: px to keep free at
   * the bottom of the page (e.g. footnotes). The page is refilled with the reservation and asked
   * again until the answer fits what is reserved. The reservation only grows within a page, so the
   * loop cannot oscillate; it is capped at `maxReserveIterations` (default 8) and then keeps the
   * last (largest) reservation tried. Assumes fewer lines never need more space.
   * When the loop ends over-reserved (the lines that needed the space moved on), the unneeded space
   * is given back by a bounded bisection that keeps the page valid. The last call for a page is
   * always with its final range (callers may keep per-page state, e.g. footnotes continued onward).
   */
  reserve?: (pageIndex: number, startLine: number, endLine: number) => number
  maxReserveIterations?: number
}

export const DEFAULT_WIDOWS = 2
export const DEFAULT_ORPHANS = 2
export const MAX_RESERVE_ITERATIONS = 8
/** Bisection steps that give back over-reserved space (see `breakPages`). */
const TIGHTEN_STEPS = 8
const EPS = 0.01

export const sideOf = (pageIndex: number) => (pageIndex % 2 === 0 ? 'recto' : 'verso')

export function breakPages(lines: readonly LineBox[], units: readonly UnitInfo[], opts: BreakOptions): PageRange[] {
  const H = opts.contentHeight
  const widows = opts.widows ?? DEFAULT_WIDOWS
  const orphans = opts.orphans ?? DEFAULT_ORPHANS
  const maxIter = opts.maxReserveIterations ?? MAX_RESERVE_ITERATIONS
  const n = lines.length
  const pages: PageRange[] = []
  if (n === 0) return [{ startLine: 0, endLine: 0, blank: false, reserved: 0 }]

  const isUnitStart = (j: number) => j === 0 || lines[j - 1].unit !== lines[j].unit
  const forcedAt = (j: number) => isUnitStart(j) && units[lines[j].unit].breakBefore !== null

  /** First line that does not go on a page starting at `i` with `avail` px. */
  const fill = (i: number, avail: number): number => {
    const top = lines[i].top
    let j = i + 1
    while (j < n && !forcedAt(j) && lines[j].bottom - top <= avail + EPS) j++
    if (j >= n || forcedAt(j)) return j
    const raw = j
    // Widows / orphans for a unit split at j.
    const u = units[lines[j].unit]
    const e = u.firstLine + u.lineCount
    if (j > u.firstLine) {
      if (e - j < widows) j = Math.max(u.firstLine, e - widows)
      if (j - u.firstLine < orphans) j = u.firstLine
      if (j <= i) return raw
    }
    // Keep with next: never end a page right after a keepWithNext unit.
    if (j > i && isUnitStart(j)) {
      let k = j
      while (k > i) {
        const prev = units[lines[k - 1].unit]
        if (!prev.keepWithNext || prev.firstLine <= i) break
        k = prev.firstLine
      }
      if (k > i) j = k
    }
    return j <= i ? raw : j
  }

  let i = 0
  while (i < n) {
    if (pages.length > 0 && isUnitStart(i) && units[lines[i].unit].breakBefore === 'recto' && sideOf(pages.length) === 'verso') {
      pages.push({ startLine: i, endLine: i, blank: true, reserved: 0 })
    }
    let reserved = 0
    let end = fill(i, H)
    let capped = false
    if (opts.reserve) {
      const reserve = opts.reserve
      let asked = -1
      const ask = (e: number) => {
        asked = e
        return clamp(reserve(pages.length, i, e), 0, H)
      }
      let need = 0
      let it = 0
      for (; it < maxIter; it++) {
        need = ask(end)
        if (need <= reserved + EPS) break
        reserved = need
        end = fill(i, H - reserved)
      }
      capped = it === maxIter
      // Over-reserved: the lines that needed the space moved to the next page (a footnote reference
      // on the last line). Give back what the page does not need, as far as the page stays valid:
      // bisection on the available height, bounded; never more than the plain fill.
      if (!capped && need < reserved - EPS) {
        let lo = H - reserved
        let hi = H - need
        let best = end
        let bestNeed = need
        for (let k = 0; k < TIGHTEN_STEPS && hi - lo > 0.5; k++) {
          const a = (lo + hi) / 2
          const e = fill(i, a)
          const r = ask(e)
          if (r <= H - a + EPS) {
            lo = a
            if (e > best) {
              best = e
              bestNeed = r
            }
          } else hi = a
        }
        end = best
        reserved = Math.max(bestNeed, 0)
      }
      // The last answer asked for a page is for its final range: stateful reservations (footnotes
      // continued from page to page) rely on it. The answer is <= `reserved` (fewer lines never need more).
      if (asked !== end) ask(end)
    }
    pages.push(capped ? { startLine: i, endLine: end, blank: false, reserved, reserveCapped: true } : { startLine: i, endLine: end, blank: false, reserved })
    i = end
  }
  return pages
}

function clamp(v: number, lo: number, hi: number) {
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo
}
