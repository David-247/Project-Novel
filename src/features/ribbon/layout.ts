/**
 * Ribbon scaling (Word's "adaptive ribbon"): as the window narrows, groups give up room one step at a
 * time. A group first goes compact (if it has a compact size), then collapses to one dropdown button
 * with its icon and name; at the narrowest widths the groups move into the overflow ("More") menu, as
 * in Word's Simplified ribbon. Steps are ordered by the group's priority, collapsing counting as a
 * bigger loss than compacting (COLLAPSE_COST), so a low-priority group collapses before a
 * high-priority one even gets compact. Ties: the rightmost group first.
 *
 * The steps are pure data: the Ribbon renders step n, measures the row's natural width and picks the
 * smallest n that fits (see `chooseStep`).
 */

export type GroupState = 'full' | 'compact' | 'collapsed' | 'overflow'

export interface LayoutGroup {
  id: string
  order: number
  priority: number
  hasCompact?: boolean
  /** false: the group never becomes a dropdown (e.g. Undo/Redo, two small buttons already). */
  collapsible?: boolean
}

export type Step = Readonly<Record<string, GroupState>>

export const COLLAPSE_COST = 15

/** Step 0 shows every group full; each later step shrinks one group by one size. */
export function ribbonSteps(groups: readonly LayoutGroup[]): Step[] {
  type Reduction = { g: LayoutGroup; to: GroupState; cost: number; kind: number }
  const reductions: Reduction[] = []
  for (const g of groups) {
    if (g.hasCompact) reductions.push({ g, to: 'compact', cost: g.priority, kind: 0 })
    if (g.collapsible !== false) reductions.push({ g, to: 'collapsed', cost: g.priority + COLLAPSE_COST, kind: 1 })
  }
  reductions.sort((a, b) => a.cost - b.cost || a.kind - b.kind || b.g.order - a.g.order)
  const overflow = [...groups].sort((a, b) => a.priority - b.priority || b.order - a.order)
  let cur: Record<string, GroupState> = Object.fromEntries(groups.map((g) => [g.id, 'full' as GroupState]))
  const out: Step[] = [cur]
  const push = (id: string, state: GroupState) => {
    cur = { ...cur, [id]: state }
    out.push(cur)
  }
  for (const r of reductions) push(r.g.id, r.to)
  for (const g of overflow) push(g.id, 'overflow')
  return out
}

/** Slack a smaller step needs before the ribbon grows back to it (no flicker at a boundary width). */
export const HYSTERESIS_PX = 24

/**
 * The step to show at `available` px, given the natural widths measured so far (`widths[n]`, undefined
 * when step n was never rendered) and the current step. Growing (a smaller n) needs HYSTERESIS_PX to
 * spare; an unmeasured smaller step is returned to be tried (rendered and measured before paint).
 * Returns `{ step, probe }`: probe = the step is unmeasured and must be checked after rendering.
 */
export function chooseStep(
  widths: readonly (number | undefined)[],
  current: number,
  available: number,
  count: number,
): { step: number; probe: boolean } {
  const last = count - 1
  const cur = Math.min(current, last)
  const w = widths[cur]
  if (w === undefined) return { step: cur, probe: true }
  // Too wide: shrink until a measured step fits (or try the next unmeasured one).
  if (w > available) {
    for (let n = cur + 1; n <= last; n++) {
      const wn = widths[n]
      if (wn === undefined) return { step: n, probe: true }
      if (wn <= available) return { step: n, probe: false }
    }
    return { step: last, probe: false }
  }
  // Fits: grow while the next larger step fits with slack.
  let best = cur
  for (let n = cur - 1; n >= 0; n--) {
    const wn = widths[n]
    if (wn === undefined) return { step: n, probe: true }
    if (wn + HYSTERESIS_PX <= available) best = n
    else break
  }
  return { step: best, probe: false }
}
