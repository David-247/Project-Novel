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
