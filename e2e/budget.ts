import { expect, type TestInfo } from '@playwright/test'

/**
 * Perf budget gate (Vibeless decision afbe3475). Budgets block CI only on the shipping pairs:
 * macOS + WebKit (WKWebView) and Windows + Chromium (WebView2). On the other pairs (macOS Chromium,
 * Windows WebKit, Linux) the measurement still runs and is reported; a miss is a warning (test
 * annotation + console line), not a failure. Functional assertions are never routed through here.
 */
export function isShippingPair(testInfo: TestInfo, platform: NodeJS.Platform = process.platform): boolean {
  const engine = /webkit/i.test(testInfo.project.name) ? 'webkit' : /chromium/i.test(testInfo.project.name) ? 'chromium' : 'other'
  return (platform === 'darwin' && engine === 'webkit') || (platform === 'win32' && engine === 'chromium')
}

/** Assert `value < limit` on a shipping pair; elsewhere warn on a miss. Returns whether it was within budget. */
export function budget(testInfo: TestInfo, name: string, value: number, limit: number): boolean {
  const ok = value < limit
  if (isShippingPair(testInfo)) {
    expect(value, `${name} (budget ${limit})`).toBeLessThan(limit)
    return ok
  }
  if (!ok) {
    const description = `${name}: ${value} >= ${limit} on ${testInfo.project.name} / ${process.platform} (not a shipping pair: reported, not blocking)`
    testInfo.annotations.push({ type: 'perf-budget-warning', description })
    console.warn(`[perf-budget-warning] ${description}`)
  }
  return ok
}
