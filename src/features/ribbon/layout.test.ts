import { describe, expect, it } from 'vitest'
import { chooseStep, HYSTERESIS_PX, ribbonSteps } from './layout'

const groups = [
  { id: 'undo', order: 10, priority: 100, collapsible: false },
  { id: 'font', order: 20, priority: 90, hasCompact: true },
  { id: 'paragraph', order: 30, priority: 70, hasCompact: true },
  { id: 'styles', order: 40, priority: 80 },
  { id: 'editing', order: 50, priority: 60 },
]

describe('ribbonSteps', () => {
  it('shrinks one group one size per step: low priority first, collapsing after compacting', () => {
    const steps = ribbonSteps(groups)
    const changes = steps.slice(1).map((s, i) => {
      const prev = steps[i]
      const id = Object.keys(s).find((k) => s[k] !== prev[k])!
      return `${id}:${s[id]}`
    })
    expect(changes).toEqual([
      'paragraph:compact',
      'editing:collapsed',
      'paragraph:collapsed',
      'font:compact',
      'styles:collapsed',
      'font:collapsed',
      'editing:overflow',
      'paragraph:overflow',
      'styles:overflow',
      'font:overflow',
      'undo:overflow',
    ])
    expect(steps[0]).toEqual({ undo: 'full', font: 'full', paragraph: 'full', styles: 'full', editing: 'full' })
  })

  it('a one-button group goes icon only, then into More, before a higher-priority group collapses', () => {
    // Review: Proofing (one button, 60) | Tracking 90 | Changes 85 | Comments 80 | Re-write 70.
    const steps = ribbonSteps([
      { id: 'proofing', order: 5, priority: 60, oneButton: true },
      { id: 'tracking', order: 10, priority: 90 },
      { id: 'changes', order: 20, priority: 85 },
      { id: 'comments', order: 30, priority: 80 },
      { id: 'rewrite', order: 40, priority: 70 },
    ])
    const changes = steps.slice(1).map((s, i) => {
      const id = Object.keys(s).find((k) => s[k] !== steps[i][k])!
      return `${id}:${s[id]}`
    })
    expect(changes).toEqual([
      'proofing:compact',
      'rewrite:collapsed',
      'proofing:overflow',
      'comments:collapsed',
      'changes:collapsed',
      'tracking:collapsed',
      'rewrite:overflow',
      'comments:overflow',
      'changes:overflow',
      'tracking:overflow',
    ])
    // Never a dropdown of one, and it moves into More once only.
    expect(steps.some((s) => s.proofing === 'collapsed')).toBe(false)
    expect(changes.filter((c) => c.startsWith('proofing:overflow'))).toHaveLength(1)
    // Comments is still full on every step until Proofing has given up all its room.
    const commentsCollapse = changes.indexOf('comments:collapsed') + 1
    expect(steps[commentsCollapse - 1].proofing).toBe('overflow')
  })

  it('ties go to the rightmost group first', () => {
    const steps = ribbonSteps([
      { id: 'a', order: 1, priority: 50 },
      { id: 'b', order: 2, priority: 50 },
    ])
    expect(steps[1]).toEqual({ a: 'full', b: 'collapsed' })
  })
})

describe('chooseStep', () => {
  const widths = [900, 800, 700, 600, 500]

  it('shrinks to the first step that fits', () => {
    expect(chooseStep(widths, 0, 650, 5)).toEqual({ step: 3, probe: false })
  })

  it('grows back only with hysteresis to spare (no flicker at the boundary)', () => {
    expect(chooseStep(widths, 3, 700, 5)).toEqual({ step: 3, probe: false })
    expect(chooseStep(widths, 3, 700 + HYSTERESIS_PX, 5)).toEqual({ step: 2, probe: false })
    expect(chooseStep(widths, 3, 2000, 5)).toEqual({ step: 0, probe: false })
  })

  it('tries an unmeasured step before deciding', () => {
    expect(chooseStep([900, undefined, 700], 0, 800, 3)).toEqual({ step: 1, probe: true })
    expect(chooseStep([undefined, 800, 700], 1, 2000, 3)).toEqual({ step: 0, probe: true })
  })

  it('grows past a wider step that does not fit to a larger step that does (non-monotonic widths)', () => {
    // Step 3 (a one-button group moved into More, adding the More button) is wider than step 2 (icon only).
    const w = [1500, 1400, 1300, 1340, 1000]
    expect(chooseStep(w, 0, 1310, 5)).toEqual({ step: 2, probe: false })
    expect(chooseStep(w, 0, 1290, 5)).toEqual({ step: 4, probe: false })
    // Back at the same width, from the narrowest step: step 2 fits with slack; step 3 does not.
    expect(chooseStep(w, 4, 1300 + HYSTERESIS_PX, 5)).toEqual({ step: 2, probe: false })
    expect(chooseStep(w, 2, 1300 + HYSTERESIS_PX, 5)).toEqual({ step: 2, probe: false })
    // Growing still needs the slack, and an unmeasured larger step is tried first.
    expect(chooseStep(w, 4, 1300 + HYSTERESIS_PX - 1, 5)).toEqual({ step: 4, probe: false })
    expect(chooseStep([1500, undefined, 1300, 1340, 1000], 4, 2000, 5)).toEqual({ step: 1, probe: true })
  })

  it('stays on the last step when nothing fits', () => {
    expect(chooseStep(widths, 4, 100, 5)).toEqual({ step: 4, probe: false })
  })

  it('is stable: the chosen step chooses itself again at the same width', () => {
    for (let avail = 400; avail <= 1000; avail += 7) {
      const { step } = chooseStep(widths, 0, avail, 5)
      expect(chooseStep(widths, step, avail, 5).step).toBe(step)
    }
  })
})
