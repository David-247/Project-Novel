import { describe, expect, it } from 'vitest'
import { describeActiveElement, logFocusOnRetry } from '../e2e/focus-log'

// A stand-in for Playwright's page: evaluate runs the function here (jsdom), as the browser would.
const page = { evaluate: async <T>(fn: () => T) => fn() } as unknown as Parameters<typeof logFocusOnRetry>[0]

describe('focus logging for toPass retries (e2e/focus-log.ts)', () => {
  it('describes the focused element', () => {
    document.body.innerHTML = '<button data-control-id="pagination.zoomIn" aria-label="Zoom in">+</button>'
    document.querySelector('button')!.focus()
    expect(describeActiveElement()).toBe('BUTTON[data-control-id=pagination.zoomIn][aria-label=Zoom in]')
    ;(document.activeElement as HTMLElement).blur()
    expect(describeActiveElement()).toBe('BODY')
  })

  it('logs document.activeElement when an attempt fails, rethrows, and stays quiet on success', async () => {
    document.body.innerHTML = '<div contenteditable="true" role="textbox"></div>'
    document.querySelector<HTMLElement>('[contenteditable]')!.focus()
    const lines: string[] = []
    let fail = true
    const attempt = logFocusOnRetry(page, 'Tab to zoom in', async () => {
      if (fail) throw new Error('not focused')
    }, (l) => lines.push(l))
    await expect(attempt()).rejects.toThrow('not focused')
    expect(lines).toEqual(['[focus] Tab to zoom in: attempt 1 failed; document.activeElement = DIV[role=textbox][contenteditable=true]'])
    fail = false
    await attempt()
    expect(lines).toHaveLength(1)
  })
})
