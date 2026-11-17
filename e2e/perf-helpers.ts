import { mkdirSync, writeFileSync } from 'node:fs'
import type { Page, TestInfo } from '@playwright/test'

/**
 * Shared by the perf specs (perf, pagination-perf, comments-perf, rewrite-perf, phase3-perf).
 * `report` writes a scenario's numbers to perf-results/<name>-<project>-<platform>.json (the CI
 * artifact read by scripts/perf-summary.mjs) and attaches them to the test report.
 */
export async function report(testInfo: TestInfo, name: string, result: Record<string, unknown>): Promise<void> {
  const full = { scenario: name, browser: testInfo.project.name, platform: process.platform, ...result, measuredAt: new Date().toISOString() }
  console.info(`[perf] ${JSON.stringify(full)}`)
  mkdirSync('perf-results', { recursive: true })
  writeFileSync(`perf-results/${name}-${testInfo.project.name}-${process.platform}.json`, JSON.stringify(full, null, 2))
  await testInfo.attach(`${name}.json`, { body: JSON.stringify(full, null, 2), contentType: 'application/json' })
}

/**
 * Input-to-paint probe: for every keydown, the time to a task after the next animation frame (that
 * frame's style, layout and paint done), pushed to `window.__perf`. The start is the event's creation
 * time when it is in the same clock (input queueing included), else the handler time.
 */
export async function installLatencyProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __perf: number[] }
    w.__perf = []
    window.addEventListener(
      'keydown',
      (e) => {
        const now = performance.now()
        const t0 = e.timeStamp > 0 && e.timeStamp <= now && now - e.timeStamp < 1000 ? e.timeStamp : now
        requestAnimationFrame(() => {
          // A task queued from rAF runs after that frame's style/layout/paint.
          const ch = new MessageChannel()
          ch.port1.onmessage = () => w.__perf.push(performance.now() - t0)
          ch.port2.postMessage(null)
        })
      },
      true,
    )
  })
}
